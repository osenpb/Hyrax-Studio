use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use crate::db::Session;
use crate::models::*;
use crate::edit::{self, ApplyResult, ChangeSet};
use crate::{db, export, profiles, secrets};

#[derive(Default)]
pub struct Sessions(Mutex<HashMap<String, Arc<Session>>>);

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|e| e.to_string())
}

async fn session(state: &State<'_, Sessions>, id: &str) -> Result<Arc<Session>, String> {
    let mut sessions = state.0.lock().await;
    match sessions.get(id) {
        Some(s) if !s.client.is_closed() => Ok(s.clone()),
        Some(_) => {
            sessions.remove(id);
            Err("La conexión se cerró. Vuelve a conectarte.".to_string())
        }
        None => Err("La conexión no está abierta.".to_string()),
    }
}

async fn drop_profile_sessions(state: &State<'_, Sessions>, profile_id: &str) {
    let prefix = format!("{profile_id}::");
    state.0.lock().await.retain(|key, _| !key.starts_with(&prefix));
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
    profiles::delete(&config_dir(&app)?, &id)
}

#[tauri::command]
pub async fn test_connection(profile: ConnectionProfile) -> Result<String, String> {
    let mut profile = profile;
    if profile.password.is_empty() {
        profile.password = secrets::get(&profile.id)?.unwrap_or_default();
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
    if profile.password.is_empty() {
        profile.password = secrets::get(&id)?.unwrap_or_default();
    }
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
    db::set_read_only(&session.client, enabled).await?;
    db::is_read_only(&session.client).await
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
