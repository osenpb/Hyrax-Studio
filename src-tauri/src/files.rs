use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::models::FileContent;

pub const MAX_DATA_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_SQL_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_SAVE_BYTES: usize = 32 * 1024 * 1024;

/// Rutas que el usuario eligió con el diálogo nativo en esta sesión. Solo sobre ellas se permite
/// volver a guardar sin preguntar, para que la interfaz web no pueda escribir en rutas arbitrarias.
#[derive(Default)]
pub struct ApprovedPaths(Mutex<HashSet<PathBuf>>);

impl ApprovedPaths {
    pub fn approve(&self, path: &Path) {
        if let Ok(mut set) = self.0.lock() {
            set.insert(path.to_path_buf());
        }
    }

    pub fn is_approved(&self, path: &Path) -> bool {
        self.0.lock().map(|set| set.contains(path)).unwrap_or(false)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Sql,
    Data,
}

impl Kind {
    pub fn parse(text: &str) -> Result<Kind, String> {
        match text {
            "sql" => Ok(Kind::Sql),
            "data" => Ok(Kind::Data),
            _ => Err("Tipo de archivo no válido.".to_string()),
        }
    }

    fn max_bytes(self) -> u64 {
        match self {
            Kind::Sql => MAX_SQL_BYTES,
            Kind::Data => MAX_DATA_BYTES,
        }
    }

    fn open_filter(self) -> (&'static str, &'static [&'static str]) {
        match self {
            Kind::Sql => ("Scripts SQL", &["sql", "txt"]),
            Kind::Data => ("CSV, TSV y JSON", &["csv", "tsv", "txt", "json"]),
        }
    }
}

pub fn decode_text(bytes: Vec<u8>) -> Result<String, String> {
    let bytes = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        Some(rest) => rest.to_vec(),
        None => bytes,
    };
    String::from_utf8(bytes).map_err(|_| {
        "El archivo no está en UTF-8. Guárdalo como UTF-8 (por ejemplo, 'CSV UTF-8' en Excel) e inténtalo de nuevo."
            .to_string()
    })
}

pub fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

pub async fn pick_and_read(app: &AppHandle, approved: &ApprovedPaths, kind: Kind) -> Result<Option<FileContent>, String> {
    let (label, extensions) = kind.open_filter();
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        handle.dialog().file().add_filter(label, extensions).blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let length = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("No se pudo leer el archivo: {e}"))?
        .len();
    if length > kind.max_bytes() {
        return Err(format!(
            "El archivo pesa {:.1} MB y el máximo es {} MB.",
            length as f64 / 1_048_576.0,
            kind.max_bytes() / 1_048_576
        ));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("No se pudo leer el archivo: {e}"))?;
    let content = decode_text(bytes)?;
    approved.approve(&path);
    Ok(Some(FileContent {
        name: file_name(&path),
        path: path.to_string_lossy().into_owned(),
        content,
    }))
}

pub async fn save(
    app: &AppHandle,
    approved: &ApprovedPaths,
    content: &str,
    default_name: &str,
    known_path: Option<&str>,
) -> Result<Option<FileContent>, String> {
    if content.len() > MAX_SAVE_BYTES {
        return Err("El contenido es demasiado grande para guardarlo.".to_string());
    }
    let target: PathBuf = match known_path.map(PathBuf::from).filter(|p| approved.is_approved(p)) {
        Some(path) => path,
        None => {
            let handle = app.clone();
            let name = default_name.to_string();
            let picked = tauri::async_runtime::spawn_blocking(move || {
                handle
                    .dialog()
                    .file()
                    .add_filter("Scripts SQL", &["sql"])
                    .set_file_name(name)
                    .blocking_save_file()
            })
            .await
            .map_err(|e| e.to_string())?;
            let Some(picked) = picked else {
                return Ok(None);
            };
            let path = picked.into_path().map_err(|e| e.to_string())?;
            approved.approve(&path);
            path
        }
    };
    tokio::fs::write(&target, content.as_bytes())
        .await
        .map_err(|e| format!("No se pudo guardar el archivo: {e}"))?;
    Ok(Some(FileContent {
        name: file_name(&target),
        path: target.to_string_lossy().into_owned(),
        content: String::new(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_and_strips_the_bom() {
        assert_eq!(decode_text(b"a,b\n1,2".to_vec()).unwrap(), "a,b\n1,2");
        assert_eq!(decode_text(vec![0xEF, 0xBB, 0xBF, b'x']).unwrap(), "x");
        let err = decode_text(vec![0xE9, b'a']).unwrap_err();
        assert!(err.contains("UTF-8"), "{err}");
    }

    #[test]
    fn only_dialog_approved_paths_can_be_rewritten() {
        let approved = ApprovedPaths::default();
        let path = PathBuf::from("C:/scripts/consulta.sql");
        assert!(!approved.is_approved(&path));
        approved.approve(&path);
        assert!(approved.is_approved(&path));
        assert!(!approved.is_approved(Path::new("C:/otra/ruta.sql")));
    }

    #[test]
    fn parses_known_kinds_only() {
        assert_eq!(Kind::parse("sql"), Ok(Kind::Sql));
        assert_eq!(Kind::parse("data"), Ok(Kind::Data));
        assert!(Kind::parse("../etc/passwd").is_err());
    }
}
