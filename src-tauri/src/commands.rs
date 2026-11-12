use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use crate::db::Session;
use crate::models::*;
use crate::mongo;
use crate::edit::{self, ApplyResult, ChangeSet};
use crate::files::{self, ApprovedPaths, Kind};
use crate::{db, dropping, export, import, profiles, schema, secrets};

#[derive(Default)]
pub struct Sessions(
    Mutex<HashMap<String, Arc<Session>>>,
    /// Sesiones de MongoDB, por id de conexión.
    Mutex<HashMap<String, Arc<mongo::MongoSession>>>,
);

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    migrate_legacy_profiles(&dir);
    Ok(dir)
}

/// Antes la app se llamaba PgDesk (`dev.osen.pgdesk`): copia sus perfiles **una sola vez**.
/// La marca `.legacy-checked` evita que, tras borrar las conexiones, reaparezcan desde la carpeta antigua.
fn migrate_legacy_profiles(dir: &std::path::Path) {
    let marker = dir.join(LEGACY_MARKER);
    if marker.exists() {
        return;
    }
    let target = dir.join("profiles.json");
    if !target.exists() {
        if let Some(legacy) = legacy_profiles_file(dir).filter(|p| p.is_file()) {
            let _ = std::fs::create_dir_all(dir);
            let _ = std::fs::copy(&legacy, &target);
        }
    }
    mark_legacy_checked(dir);
}

const LEGACY_MARKER: &str = ".legacy-checked";

fn legacy_profiles_file(dir: &std::path::Path) -> Option<PathBuf> {
    Some(dir.parent()?.join("dev.osen.pgdesk").join("profiles.json"))
}

fn mark_legacy_checked(dir: &std::path::Path) {
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(dir.join(LEGACY_MARKER), b"");
}

fn ssh_secret_key(id: &str) -> String {
    format!("ssh:{id}")
}

/// Completa con lo guardado en el almacén del sistema lo que la interfaz dejó vacío.
fn load_secrets(profile: &mut ConnectionProfile) -> Result<(), String> {
    if profile.password.is_empty() {
        profile.password = secrets::get(&profile.id)?.unwrap_or_default();
    }
    if profile.ssh.enabled && profile.ssh.secret.is_empty() && !profile.ssh.clear_secret {
        profile.ssh.secret = secrets::get(&ssh_secret_key(&profile.id))?.unwrap_or_default();
    }
    Ok(())
}

async fn session(state: &State<'_, Sessions>, id: &str) -> Result<Arc<Session>, String> {
    let found = {
        let mut sessions = state.0.lock().await;
        let found = sessions.get(id).cloned();
        if matches!(&found, Some(s) if s.client.is_closed()) {
            sessions.remove(id);
            return Err("La conexión se cerró. Vuelve a conectarte.".to_string());
        }
        found
    };
    let session = found.ok_or_else(|| "La conexión no está abierta.".to_string())?;
    db::enforce_write_window(&session).await;
    Ok(session)
}

async fn drop_profile_sessions(state: &State<'_, Sessions>, profile_id: &str) {
    let prefix = format!("{profile_id}::");
    state.0.lock().await.retain(|key, _| !key.starts_with(&prefix));
    state.1.lock().await.remove(profile_id);
}

#[tauri::command]
pub fn list_profiles(app: AppHandle) -> Result<Vec<ConnectionProfile>, String> {
    let dir = config_dir(&app)?;
    let mut list = profiles::load(&dir)?;
    let mut migrated = false;
    for profile in list.iter_mut() {
        if !profile.password.is_empty() {
            secrets::set(&profile.id, &profile.password)?;
            if secrets::get(&profile.id)?.as_deref() != Some(profile.password.as_str()) {
                return Err(
                    "No se pudo verificar que la contraseña quedó guardada en el almacén del sistema; el archivo de conexiones no se modificó."
                        .to_string(),
                );
            }
            migrated = true;
        }
        profile.has_password = secrets::get(&profile.id).ok().flatten().is_some();
        profile.password.clear();
        profile.ssh.has_secret = profile.ssh.enabled
            && secrets::get(&ssh_secret_key(&profile.id)).ok().flatten().is_some();
        profile.ssh.secret.clear();
    }
    if migrated {
        profiles::store(&dir, &list)?;
    }
    Ok(list)
}

#[tauri::command]
pub fn save_profile(app: AppHandle, profile: ConnectionProfile) -> Result<(), String> {
    let mut profile = profile;
    if !profile.password.is_empty() {
        secrets::set(&profile.id, &profile.password)?;
    }
    profile.password.clear();
    profile.has_password = false;
    // El secreto SSH solo se guarda si el túnel está activo; si se desactiva o se pide olvidarlo, se borra.
    if !profile.ssh.enabled || profile.ssh.clear_secret {
        secrets::delete(&ssh_secret_key(&profile.id))?;
    }
    if profile.ssh.enabled && !profile.ssh.secret.is_empty() {
        secrets::set(&ssh_secret_key(&profile.id), &profile.ssh.secret)?;
    }
    profile.ssh.secret.clear();
    profile.ssh.has_secret = false;
    profile.ssh.clear_secret = false;
    profiles::save(&config_dir(&app)?, profile)
}

#[tauri::command]
pub async fn delete_profile(
    app: AppHandle,
    state: State<'_, Sessions>,
    id: String,
) -> Result<(), String> {
    drop_profile_sessions(&state, &id).await;
    secrets::delete(&id)?;
    secrets::delete(&ssh_secret_key(&id))?;
    profiles::delete(&config_dir(&app)?, &id)
}

/// Palabra que el usuario debe escribir para borrar todo lo guardado: la del idioma de la interfaz
/// (español o inglés). El backend acepta las dos.
const RESET_CONFIRMS: [&str; 2] = ["BORRAR", "ERASE"];

fn reset_word_ok(typed: &str) -> bool {
    RESET_CONFIRMS.contains(&typed)
}

/// Borra todas las conexiones guardadas y sus contraseñas (y claves SSH) del almacén del sistema.
/// Cierra las sesiones abiertas. Devuelve cuántas conexiones había.
#[tauri::command]
pub async fn reset_app_data(
    app: AppHandle,
    state: State<'_, Sessions>,
    confirm: String,
) -> Result<usize, String> {
    if !reset_word_ok(&confirm) {
        return Err("Para borrar todo hay que escribir BORRAR (o ERASE).".to_string());
    }
    let dir = config_dir(&app)?;
    state.0.lock().await.clear();
    state.1.lock().await.clear();
    reset_in(&dir)
}

/// Lógica del borrado total sobre una carpeta de configuración (separada para poder probarla sin la app).
fn reset_in(dir: &std::path::Path) -> Result<usize, String> {
    // Si el archivo está dañado no se pueden conocer los ids: se borra igual.
    let mut list = profiles::load(dir).unwrap_or_default();
    // También los de la copia antigua de PgDesk, si sigue en disco, para no dejar sus contraseñas huérfanas.
    if let Some(legacy_dir) = legacy_profiles_file(dir).and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        for p in profiles::load(&legacy_dir).unwrap_or_default() {
            if !list.iter().any(|x| x.id == p.id) {
                list.push(p);
            }
        }
    }

    let mut failures = Vec::new();
    for profile in &list {
        for result in [
            secrets::delete(&profile.id),
            secrets::delete(&ssh_secret_key(&profile.id)),
            secrets::delete_legacy(&profile.id),
        ] {
            if let Err(e) = result {
                failures.push(e);
            }
        }
    }
    // Los archivos se borran al final: si algo falló arriba, se puede reintentar sin perder la lista.
    if !failures.is_empty() {
        failures.dedup();
        return Err(format!(
            "No se borró todo; se conservaron las conexiones para poder reintentar. {}",
            failures.join(" ")
        ));
    }
    profiles::clear(dir)?;
    // La copia antigua de PgDesk también se va: si no, volvería a copiarse o seguiría en disco.
    if let Some(legacy) = legacy_profiles_file(dir) {
        match std::fs::remove_file(&legacy) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("No se pudo borrar la copia antigua de PgDesk ({}): {e}", legacy.display())),
        }
    }
    mark_legacy_checked(dir);
    Ok(list.len())
}

// ---------------------------------------------------------------------------------------------
// MongoDB (fase M1: explorar en solo lectura)
// ---------------------------------------------------------------------------------------------

async fn mongo_session(state: &State<'_, Sessions>, id: &str) -> Result<Arc<mongo::MongoSession>, String> {
    state
        .1
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| "La conexión de MongoDB no está abierta. Vuelve a conectarte.".to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoConnectInfo {
    pub version: String,
    pub read_only: bool,
}

#[tauri::command]
pub async fn mongo_connect(
    app: AppHandle,
    state: State<'_, Sessions>,
    id: String,
) -> Result<MongoConnectInfo, String> {
    let mut profile = profiles::find(&config_dir(&app)?, &id)?;
    if profile.engine != Engine::Mongodb {
        return Err("La conexión no es de MongoDB.".to_string());
    }
    load_secrets(&mut profile)?;
    let client = mongo::connect(&profile).await?;
    let version = mongo::version(&client).await?;
    let session = mongo::MongoSession {
        client,
        production: profile.production,
        default_db: profile.database.trim().to_string(),
    };
    state.1.lock().await.insert(id, Arc::new(session));
    // En M1 todo es de solo lectura: no hay ningún comando de escritura.
    Ok(MongoConnectInfo { version, read_only: true })
}

#[tauri::command]
pub async fn mongo_disconnect(state: State<'_, Sessions>, id: String) -> Result<(), String> {
    state.1.lock().await.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn mongo_list_databases(
    state: State<'_, Sessions>,
    id: String,
) -> Result<Vec<mongo::browse::DatabaseInfo>, String> {
    let s = mongo_session(&state, &id).await?;
    mongo::browse::list_databases(&s.client, &s.default_db).await
}

#[tauri::command]
pub async fn mongo_list_collections(
    state: State<'_, Sessions>,
    id: String,
    database: String,
) -> Result<Vec<mongo::browse::CollectionInfo>, String> {
    let s = mongo_session(&state, &id).await?;
    mongo::browse::list_collections(&s.client, &database).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mongo_find(
    state: State<'_, Sessions>,
    id: String,
    database: String,
    collection: String,
    filter: String,
    sort: String,
    projection: String,
    skip: u64,
    limit: i64,
    timeout_ms: u64,
) -> Result<mongo::browse::FindPage, String> {
    let s = mongo_session(&state, &id).await?;
    let params = mongo::browse::FindParams {
        filter: mongo::query::parse_document(&filter, "El filtro")?,
        sort: mongo::query::parse_document(&sort, "El orden")?,
        projection: mongo::query::parse_document(&projection, "La proyección")?,
        skip,
        limit,
        timeout: mongo::query::effective_timeout(timeout_ms, s.production),
    };
    mongo::browse::find(&s.client, &database, &collection, params).await
}

#[tauri::command]
pub async fn mongo_count(
    state: State<'_, Sessions>,
    id: String,
    database: String,
    collection: String,
    filter: String,
    timeout_ms: u64,
) -> Result<u64, String> {
    let s = mongo_session(&state, &id).await?;
    let filter = mongo::query::parse_document(&filter, "El filtro")?;
    let timeout = mongo::query::effective_timeout(timeout_ms, s.production);
    mongo::browse::count(&s.client, &database, &collection, filter, timeout).await
}

#[tauri::command]
pub async fn mongo_estimated_count(
    state: State<'_, Sessions>,
    id: String,
    database: String,
    collection: String,
) -> Result<u64, String> {
    let s = mongo_session(&state, &id).await?;
    mongo::browse::estimated_count(&s.client, &database, &collection).await
}

#[tauri::command]
pub async fn test_connection(profile: ConnectionProfile) -> Result<String, String> {
    let mut profile = profile;
    load_secrets(&mut profile)?;
    if profile.engine == Engine::Mongodb {
        return mongo::test(&profile).await;
    }
    let session = db::connect(&profile).await?;
    db::server_version(&session.client).await
}

#[tauri::command]
pub async fn connect_profile(
    app: AppHandle,
    state: State<'_, Sessions>,
    id: String,
    database: String,
) -> Result<ConnectInfo, String> {
    let mut profile = profiles::find(&config_dir(&app)?, &id)?;
    if profile.engine == Engine::Mongodb {
        return Err("El explorador de MongoDB llega en la fase M1. Por ahora puedes crear la conexión y probarla.".to_string());
    }
    load_secrets(&mut profile)?;
    profile.database = database.clone();
    let session = db::connect(&profile).await?;
    let version = db::server_version(&session.client).await?;
    let read_only = db::is_read_only(&session.client).await?;
    state
        .0
        .lock()
        .await
        .insert(format!("{id}::{database}"), Arc::new(session));
    Ok(ConnectInfo { version, read_only })
}

/// Vuelve a abrir cada sesión abierta de una conexión con las credenciales guardadas, sin cerrar las pestañas.
/// La sesión vieja se reemplaza solo cuando la nueva conectó; si una base falla, esa conserva la anterior.
/// Las sesiones nuevas arrancan en solo lectura, como al conectar por primera vez.
#[tauri::command]
pub async fn reconnect_profile(
    app: AppHandle,
    state: State<'_, Sessions>,
    id: String,
) -> Result<ReconnectResult, String> {
    let prefix = format!("{id}::");
    let keys: Vec<String> = state.0.lock().await.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
    let mut result = ReconnectResult { reconnected: Vec::new(), failed: Vec::new() };
    if keys.is_empty() {
        return Ok(result);
    }
    let mut profile = profiles::find(&config_dir(&app)?, &id)?;
    load_secrets(&mut profile)?;
    for key in keys {
        let database = key[prefix.len()..].to_string();
        let mut p = profile.clone();
        p.database = database.clone();
        let opened = async {
            let session = db::connect(&p).await?;
            let version = db::server_version(&session.client).await?;
            let read_only = db::is_read_only(&session.client).await?;
            Ok::<_, String>((session, ConnectInfo { version, read_only }))
        }
        .await;
        match opened {
            Ok((session, info)) => {
                state.0.lock().await.insert(key.clone(), Arc::new(session));
                result.reconnected.push(ReconnectedSession { key, info });
            }
            Err(error) => result.failed.push(ReconnectFailure { database, error }),
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, Sessions>, id: String) -> Result<(), String> {
    state.0.lock().await.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn disconnect_profile(state: State<'_, Sessions>, id: String) -> Result<(), String> {
    drop_profile_sessions(&state, &id).await;
    Ok(())
}

#[tauri::command]
pub async fn set_read_only(
    state: State<'_, Sessions>,
    id: String,
    enabled: bool,
    confirm: Option<String>,
) -> Result<bool, String> {
    let session = session(&state, &id).await?;
    if !enabled {
        db::check_write_unlock(session.production, &session.database, confirm.as_deref())?;
    }
    db::apply_mode(&session, enabled).await
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, Sessions>, id: String) -> Result<(), String> {
    let session = session(&state, &id).await?;
    db::cancel(&session).await
}

#[tauri::command]
pub async fn list_databases(state: State<'_, Sessions>, id: String) -> Result<Vec<String>, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.read().await;
    db::list_databases(&session.client).await
}

#[tauri::command]
pub async fn completion_schema(
    state: State<'_, Sessions>,
    id: String,
) -> Result<Vec<CompletionTable>, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.read().await;
    db::completion_schema(&session.client).await
}

#[tauri::command]
pub async fn list_schemas(state: State<'_, Sessions>, id: String) -> Result<Vec<SchemaInfo>, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.read().await;
    db::list_schemas(&session.client).await
}

#[tauri::command]
pub async fn list_relations(
    state: State<'_, Sessions>,
    id: String,
    schema: String,
) -> Result<Vec<RelationInfo>, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.read().await;
    db::list_relations(&session.client, &schema).await
}

#[tauri::command]
pub async fn list_columns(
    state: State<'_, Sessions>,
    id: String,
    schema: String,
    table: String,
) -> Result<Vec<ColumnInfo>, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.read().await;
    db::list_columns(&session.client, &schema, &table).await
}

#[tauri::command]
pub async fn table_data(
    state: State<'_, Sessions>,
    id: String,
    schema: String,
    table: String,
    limit: u32,
    offset: u64,
    filters: Vec<ColumnFilter>,
    order: Vec<SortKey>,
) -> Result<TablePage, String> {
    let limit = limit.clamp(1, 5000);
    let session = session(&state, &id).await?;
    let _gate = session.gate.read().await;
    db::table_page(
        &session,
        &schema,
        &table,
        limit,
        offset,
        &filters,
        &order,
    )
    .await
}

#[tauri::command]
pub async fn count_rows(
    state: State<'_, Sessions>,
    id: String,
    schema: String,
    table: String,
    filters: Vec<ColumnFilter>,
) -> Result<i64, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.read().await;
    db::count_rows(&session, &schema, &table, &filters).await
}

#[tauri::command]
pub async fn run_sql(
    state: State<'_, Sessions>,
    id: String,
    sql: String,
    limit: u32,
    timeout_ms: u64,
) -> Result<QueryOutput, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.read().await;
    let timeout_ms = db::effective_timeout(&session, timeout_ms);
    db::run_sql(&session, &sql, limit.clamp(1, 10000) as usize, timeout_ms).await
}

#[tauri::command]
pub async fn export_table(
    state: State<'_, Sessions>,
    id: String,
    schema: String,
    table: String,
    filters: Vec<ColumnFilter>,
    order: Vec<SortKey>,
    format: ExportFormat,
    path: String,
) -> Result<ExportResult, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.read().await;
    let sql = db::table_select_sql(&schema, &table, &filters, &order, None)?;
    let label = format!("{}.{}", db::quote_ident(&schema), db::quote_ident(&table));
    let rows = export::export_query(&session, &sql, format, &path, &label).await?;
    Ok(ExportResult { rows })
}

#[tauri::command]
pub async fn export_sql(
    state: State<'_, Sessions>,
    id: String,
    sql: String,
    format: ExportFormat,
    path: String,
) -> Result<ExportResult, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.read().await;
    let statement = sql.trim().trim_end_matches(';').trim().to_string();
    let rows = export::export_query(&session, &statement, format, &path, "\"resultado\"").await?;
    Ok(ExportResult { rows })
}

#[tauri::command]
pub async fn preview_changes(
    state: State<'_, Sessions>,
    id: String,
    schema: String,
    table: String,
    changes: ChangeSet,
) -> Result<Vec<String>, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.read().await;
    edit::preview_changes(&session, &schema, &table, &changes).await
}

#[tauri::command]
pub async fn apply_changes(
    state: State<'_, Sessions>,
    id: String,
    schema: String,
    table: String,
    changes: ChangeSet,
) -> Result<ApplyResult, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.write().await;
    edit::apply_changes(&session, &schema, &table, &changes).await
}

#[tauri::command]
pub async fn search_objects(state: State<'_, Sessions>, id: String) -> Result<Vec<ObjectRef>, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.read().await;
    schema::search_objects(&session.client).await
}

#[tauri::command]
pub async fn table_structure(
    state: State<'_, Sessions>,
    id: String,
    schema: String,
    table: String,
) -> Result<TableStructure, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.read().await;
    schema::table_structure(&session.client, &schema, &table).await
}

#[tauri::command]
pub async fn object_ddl(
    state: State<'_, Sessions>,
    id: String,
    schema: String,
    name: String,
    kind: String,
    oid: Option<u32>,
) -> Result<String, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.read().await;
    schema::object_ddl(&session.client, &schema, &name, &kind, oid).await
}

#[tauri::command]
pub async fn completion_fks(state: State<'_, Sessions>, id: String) -> Result<Vec<ForeignKey>, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.read().await;
    schema::completion_fks(&session.client).await
}

#[tauri::command]
pub async fn import_rows(
    state: State<'_, Sessions>,
    id: String,
    schema: String,
    table: String,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    dry_run: bool,
) -> Result<ImportResult, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.write().await;
    import::import_rows(&session, &schema, &table, &columns, &rows, dry_run).await
}

#[tauri::command]
pub async fn drop_object(
    state: State<'_, Sessions>,
    id: String,
    schema: String,
    name: String,
    kind: String,
    cascade: bool,
    confirm: String,
) -> Result<String, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.write().await;
    dropping::drop_object(&session, &schema, &name, &kind, cascade, &confirm).await
}

#[tauri::command]
pub async fn drop_database(
    app: AppHandle,
    state: State<'_, Sessions>,
    id: String,
    database: String,
    force: bool,
    confirm: String,
) -> Result<String, String> {
    dropping::check_confirm(&database, &confirm)?;
    dropping::drop_database_sql(&database, force)?;

    // Solo se permite si el usuario habilitó la escritura en alguna base de este servidor.
    let prefix = format!("{id}::");
    let write_enabled = {
        let sessions = state.0.lock().await;
        sessions
            .iter()
            .any(|(key, s)| key.starts_with(&prefix) && !s.read_only.load(std::sync::atomic::Ordering::SeqCst))
    };
    if !write_enabled {
        return Err(
            "Para eliminar una base de datos hay que habilitar antes la escritura en este servidor (botón de modo de cualquiera de sus bases)."
                .to_string(),
        );
    }

    let mut profile = profiles::find(&config_dir(&app)?, &id)?;
    load_secrets(&mut profile)?;
    // Se cierra nuestra propia sesión a esa base: si no, ella misma impediría eliminarla.
    let own = state.0.lock().await.remove(&format!("{id}::{database}"));
    drop(own);
    dropping::drop_database(&profile, &database, force, &confirm).await
}

#[tauri::command]
pub async fn open_text_file(
    app: AppHandle,
    approved: State<'_, ApprovedPaths>,
    kind: String,
) -> Result<Option<FileContent>, String> {
    files::pick_and_read(&app, &approved, Kind::parse(&kind)?).await
}

#[tauri::command]
pub async fn save_text_file(
    app: AppHandle,
    approved: State<'_, ApprovedPaths>,
    content: String,
    default_name: String,
    path: Option<String>,
) -> Result<Option<FileContent>, String> {
    files::save(&app, &approved, &content, &default_name, path.as_deref()).await
}

#[tauri::command]
pub async fn run_sql_dry(
    state: State<'_, Sessions>,
    id: String,
    sql: String,
    limit: u32,
    timeout_ms: u64,
) -> Result<QueryOutput, String> {
    let session = session(&state, &id).await?;
    let _gate = session.gate.write().await;
    let timeout_ms = db::effective_timeout(&session, timeout_ms);
    db::run_sql_dry(&session, &sql, limit.clamp(1, 10000) as usize, timeout_ms).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hyrax-migrate-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn legacy_profiles_are_copied_once_and_never_overwrite_new_ones() {
        let root = temp("a");
        let legacy = root.join("dev.osen.pgdesk");
        let current = root.join("dev.osen.hyrax");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("profiles.json"), "[\"viejo\"]").unwrap();

        migrate_legacy_profiles(&current);
        assert_eq!(std::fs::read_to_string(current.join("profiles.json")).unwrap(), "[\"viejo\"]");

        // Si ya hay perfiles nuevos, no se tocan aunque el archivo viejo cambie.
        std::fs::write(current.join("profiles.json"), "[\"nuevo\"]").unwrap();
        std::fs::write(legacy.join("profiles.json"), "[\"otro\"]").unwrap();
        migrate_legacy_profiles(&current);
        assert_eq!(std::fs::read_to_string(current.join("profiles.json")).unwrap(), "[\"nuevo\"]");
        // El original se conserva.
        assert!(legacy.join("profiles.json").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_erase_word_is_accepted_in_both_languages_and_nothing_else() {
        assert!(reset_word_ok("BORRAR"));
        assert!(reset_word_ok("ERASE"));
        for bad in ["", "borrar", "erase", "Borrar", " BORRAR", "BORRAR ", "DELETE"] {
            assert!(!reset_word_ok(bad), "{bad:?}");
        }
    }

    #[test]
    fn without_a_legacy_folder_no_profiles_are_created() {
        let root = temp("b");
        let current = root.join("dev.osen.hyrax");
        migrate_legacy_profiles(&current);
        assert!(!current.join("profiles.json").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn deleted_profiles_do_not_come_back_from_the_legacy_folder() {
        let root = temp("c");
        let legacy = root.join("dev.osen.pgdesk");
        let current = root.join("dev.osen.hyrax");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("profiles.json"), "[\"viejo\"]").unwrap();

        migrate_legacy_profiles(&current);
        assert!(current.join("profiles.json").exists());

        // El usuario borra todo: se quita el archivo nuevo, pero la marca impide copiar de nuevo.
        std::fs::remove_file(current.join("profiles.json")).unwrap();
        migrate_legacy_profiles(&current);
        assert!(!current.join("profiles.json").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reset_removes_files_and_every_stored_secret_and_nothing_comes_back() {
        let root = temp("reset");
        let legacy = root.join("dev.osen.pgdesk");
        let current = root.join("dev.osen.hyrax");
        std::fs::create_dir_all(&legacy).unwrap();
        let pid = std::process::id();
        let (a, b) = (format!("reset-a-{pid}"), format!("reset-b-{pid}"));

        // a: perfil actual con contraseña y secreto SSH; b: solo en la copia antigua, con contraseña antigua.
        let mk = |id: &str| profiles::store(
            &current,
            &[serde_json::from_str::<ConnectionProfile>(&format!(
                r#"{{"id":"{id}","name":"n","host":"h","port":1,"database":"d","user":"u"}}"#
            ))
            .unwrap()],
        );
        mk(&a).unwrap();
        profiles::store(
            &legacy,
            &[serde_json::from_str::<ConnectionProfile>(&format!(
                r#"{{"id":"{b}","name":"n","host":"h","port":1,"database":"d","user":"u"}}"#
            ))
            .unwrap()],
        )
        .unwrap();
        secrets::set(&a, "pw-a").unwrap();
        secrets::set(&ssh_secret_key(&a), "ssh-a").unwrap();
        keyring::Entry::new("pgdesk", &b).unwrap().set_password("pw-b-antigua").unwrap();
        mark_legacy_checked(&current);

        assert_eq!(reset_in(&current).unwrap(), 2);

        assert_eq!(secrets::get(&a).unwrap(), None);
        assert_eq!(secrets::get(&ssh_secret_key(&a)).unwrap(), None);
        assert!(matches!(
            keyring::Entry::new("pgdesk", &b).unwrap().get_password(),
            Err(keyring::Error::NoEntry)
        ));
        assert!(profiles::load(&current).unwrap().is_empty());
        assert!(!legacy.join("profiles.json").exists());

        // Y no resucita al volver a abrir la app.
        migrate_legacy_profiles(&current);
        assert!(profiles::load(&current).unwrap().is_empty());
        // Repetirlo no falla.
        assert_eq!(reset_in(&current).unwrap(), 0);
        let _ = std::fs::remove_dir_all(root);
    }
}
