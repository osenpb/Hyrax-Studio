use std::fs;
use std::path::{Path, PathBuf};

use crate::models::ConnectionProfile;

fn file(dir: &Path) -> PathBuf {
    dir.join("profiles.json")
}

pub fn load(dir: &Path) -> Result<Vec<ConnectionProfile>, String> {
    let path = file(dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("profiles.json inválido: {e}"))
}

fn store(dir: &Path, profiles: &[ConnectionProfile]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(profiles).map_err(|e| e.to_string())?;
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

pub fn find(dir: &Path, id: &str) -> Result<ConnectionProfile, String> {
    load(dir)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "Conexión no encontrada".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SslMode;

    fn sample(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: id.into(),
            name: name.into(),
            host: "localhost".into(),
            port: 5432,
            database: "db".into(),
            user: "u".into(),
            password: "p".into(),
            ssl_mode: SslMode::Disable,
            read_only: true,
        }
    }

    #[test]
    fn save_update_delete_roundtrip() {
        let dir = std::env::temp_dir().join(format!("pgdesk-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

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
}
