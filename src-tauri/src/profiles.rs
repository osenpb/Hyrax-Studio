use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::models::{ConnectionProfile, Engine, MongoSettings, SshSettings, SslMode};

fn default_read_only() -> bool {
    true
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    id: String,
    name: String,
    host: String,
    port: u16,
    database: String,
    user: String,
    #[serde(default, skip_serializing)]
    password: String,
    #[serde(default)]
    ssl_mode: SslMode,
    #[serde(default = "default_read_only")]
    read_only: bool,
    #[serde(default)]
    production: bool,
    #[serde(default)]
    ca_cert_path: Option<String>,
    #[serde(default)]
    ssh: SshSettings,
    #[serde(default)]
    engine: Engine,
    #[serde(default)]
    mongo: MongoSettings,
}

impl From<&ConnectionProfile> for Stored {
    fn from(p: &ConnectionProfile) -> Self {
        Stored {
            id: p.id.clone(),
            name: p.name.clone(),
            host: p.host.clone(),
            port: p.port,
            database: p.database.clone(),
            user: p.user.clone(),
            password: String::new(),
            ssl_mode: p.ssl_mode,
            read_only: p.read_only,
            production: p.production,
            ca_cert_path: p.ca_cert_path.clone(),
            ssh: SshSettings { secret: String::new(), has_secret: false, clear_secret: false, ..p.ssh.clone() },
            engine: p.engine,
            mongo: p.mongo.clone(),
        }
    }
}

impl From<Stored> for ConnectionProfile {
    fn from(s: Stored) -> Self {
        ConnectionProfile {
            id: s.id,
            name: s.name,
            host: s.host,
            port: s.port,
            database: s.database,
            user: s.user,
            password: s.password,
            ssl_mode: s.ssl_mode,
            read_only: s.read_only,
            production: s.production,
            ca_cert_path: s.ca_cert_path,
            has_password: false,
            ssh: s.ssh,
            engine: s.engine,
            mongo: s.mongo,
        }
    }
}

fn file(dir: &Path) -> PathBuf {
    dir.join("profiles.json")
}

pub fn load(dir: &Path) -> Result<Vec<ConnectionProfile>, String> {
    let path = file(dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let stored: Vec<Stored> =
        serde_json::from_str(&text).map_err(|e| format!("profiles.json inválido: {e}"))?;
    Ok(stored.into_iter().map(ConnectionProfile::from).collect())
}

pub fn store(dir: &Path, profiles: &[ConnectionProfile]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stored: Vec<Stored> = profiles.iter().map(Stored::from).collect();
    let text = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
    let path = file(dir);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn save(dir: &Path, profile: ConnectionProfile) -> Result<(), String> {
    let mut profiles = load(dir)?;
    match profiles.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = profile,
        None => profiles.push(profile),
    }
    store(dir, &profiles)
}

pub fn delete(dir: &Path, id: &str) -> Result<(), String> {
    let mut profiles = load(dir)?;
    profiles.retain(|p| p.id != id);
    store(dir, &profiles)
}

/// Borra el archivo de conexiones (y su temporal). No falla si no existe.
pub fn clear(dir: &Path) -> Result<(), String> {
    let path = file(dir);
    for p in [path.with_extension("json.tmp"), path] {
        match fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("No se pudo borrar {}: {e}", p.display())),
        }
    }
    Ok(())
}

pub fn find(dir: &Path, id: &str) -> Result<ConnectionProfile, String> {
    load(dir)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "Conexión no encontrada".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.into(),
            name: name.into(),
            host: "localhost".into(),
            port: 5432,
            database: "db".into(),
            user: "u".into(),
            password: "TOPSECRET".into(),
            ssl_mode: SslMode::Disable,
            read_only: true,
            production: false,
            ca_cert_path: None,
            has_password: true,
            ssh: Default::default(),
            engine: Default::default(),
            mongo: Default::default(),
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hyrax-test-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn save_update_delete_roundtrip() {
        let dir = temp_dir("roundtrip");

        assert!(load(&dir).unwrap().is_empty());
        save(&dir, sample("a", "uno")).unwrap();
        save(&dir, sample("b", "dos")).unwrap();
        save(&dir, sample("a", "uno-editado")).unwrap();

        let loaded = load(&dir).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(find(&dir, "a").unwrap().name, "uno-editado");

        delete(&dir, "a").unwrap();
        assert_eq!(load(&dir).unwrap().len(), 1);
        assert!(find(&dir, "a").is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_file_never_contains_the_password() {
        let dir = temp_dir("nopassword");
        save(&dir, sample("a", "uno")).unwrap();
        let text = fs::read_to_string(file(&dir)).unwrap();
        assert!(!text.contains("TOPSECRET"), "{text}");
        assert!(!text.to_lowercase().contains("password"), "{text}");
        assert!(load(&dir).unwrap()[0].password.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_plaintext_passwords_are_readable_once_and_dropped_on_rewrite() {
        let dir = temp_dir("legacy");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            file(&dir),
            r#"[{"id":"x","name":"old","host":"h","port":5432,"database":"d","user":"u","password":"LEGACYPW","sslMode":"require"}]"#,
        )
        .unwrap();

        let loaded = load(&dir).unwrap();
        assert_eq!(loaded[0].password, "LEGACYPW");
        assert_eq!(loaded[0].ssl_mode, SslMode::Require);
        assert!(loaded[0].read_only);
        assert!(!loaded[0].production);

        store(&dir, &loaded).unwrap();
        let text = fs::read_to_string(file(&dir)).unwrap();
        assert!(!text.contains("LEGACYPW"), "{text}");
        assert_eq!(load(&dir).unwrap()[0].password, "");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_removes_the_file_and_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("hyrax-clear-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        clear(&dir).unwrap(); // sin carpeta: no es un error
        store(&dir, &[sample("a", "A"), sample("b", "B")]).unwrap();
        assert_eq!(load(&dir).unwrap().len(), 2);
        clear(&dir).unwrap();
        assert!(load(&dir).unwrap().is_empty());
        assert!(!dir.join("profiles.json").exists());
        clear(&dir).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn profiles_saved_before_engines_existed_are_postgres_and_mongo_fields_round_trip() {
        let dir = std::env::temp_dir().join(format!("hyrax-engine-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("profiles.json"),
            r#"[{"id":"a","name":"viejo","host":"h","port":5432,"database":"d","user":"u"}]"#,
        )
        .unwrap();
        let loaded = load(&dir).unwrap();
        assert_eq!(loaded[0].engine, Engine::Postgres);

        let mut mongo = sample("m", "atlas");
        mongo.engine = Engine::Mongodb;
        mongo.mongo = MongoSettings {
            srv: true,
            extra_hosts: "h2:27017".into(),
            auth_source: Some("admin".into()),
            replica_set: Some("rs0".into()),
            direct_connection: false,
        };
        save(&dir, mongo).unwrap();
        let again = find(&dir, "m").unwrap();
        assert_eq!(again.engine, Engine::Mongodb);
        assert!(again.mongo.srv);
        assert_eq!(again.mongo.replica_set.as_deref(), Some("rs0"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
