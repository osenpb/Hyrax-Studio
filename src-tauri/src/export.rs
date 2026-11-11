use std::path::PathBuf;
use std::pin::pin;

use futures_util::TryStreamExt;
use tokio::io::{AsyncWrite, AsyncWriteExt, BufWriter};
use tokio_postgres::types::Type;
use tokio_postgres::SimpleQueryMessage;

use crate::db::{self, Session};
use crate::models::ExportFormat;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Number,
    Bool,
    Json,
    Text,
}

fn kind_of(ty: &Type) -> Kind {
    match *ty {
        Type::INT2 | Type::INT4 | Type::INT8 | Type::FLOAT4 | Type::FLOAT8 | Type::NUMERIC | Type::OID => {
            Kind::Number
        }
        Type::BOOL => Kind::Bool,
        Type::JSON | Type::JSONB => Kind::Json,
        _ => Kind::Text,
    }
}

fn is_plain_number(value: &str) -> bool {
    value.parse::<f64>().map(|f| f.is_finite()).unwrap_or(false)
}

pub fn csv_field(value: Option<&str>) -> String {
    match value {
        None => String::new(),
        Some(v) if v.contains(['"', ',', '\n', '\r']) => format!("\"{}\"", v.replace('"', "\"\"")),
        Some(v) => v.to_string(),
    }
}

pub fn json_value(value: Option<&str>, kind: Kind) -> String {
    let Some(v) = value else {
        return "null".to_string();
    };
    match kind {
        Kind::Number if is_plain_number(v) => v.to_string(),
        Kind::Bool if v == "t" => "true".to_string(),
        Kind::Bool if v == "f" => "false".to_string(),
        Kind::Json => match serde_json::from_str::<serde_json::Value>(v) {
            Ok(parsed) => parsed.to_string(),
            Err(_) => serde_json::Value::String(v.to_string()).to_string(),
        },
        _ => serde_json::Value::String(v.to_string()).to_string(),
    }
}

pub fn sql_value(value: Option<&str>, kind: Kind) -> String {
    let Some(v) = value else {
        return "NULL".to_string();
    };
    match kind {
        Kind::Number if is_plain_number(v) => v.to_string(),
        Kind::Bool if v == "t" => "TRUE".to_string(),
        Kind::Bool if v == "f" => "FALSE".to_string(),
        _ => db::quote_literal(v),
    }
}

pub async fn write_rows<W: AsyncWrite + Unpin>(
    session: &Session,
    sql: &str,
    format: ExportFormat,
    columns: &[(String, Kind)],
    table_label: &str,
    out: &mut W,
) -> Result<u64, String> {
    let io = |e: std::io::Error| format!("No se pudo escribir el archivo: {e}");
    let stream = session
        .client
        .simple_query_raw(sql)
        .await
        .map_err(db::err)?;
    let mut stream = pin!(stream);

    let insert_prefix = format!(
        "INSERT INTO {} ({}) VALUES (",
        table_label,
        columns
            .iter()
            .map(|(name, _)| db::quote_ident(name))
            .collect::<Vec<_>>()
            .join(", ")
    );

    match format {
        ExportFormat::Csv => {
            out.write_all(b"\xEF\xBB\xBF").await.map_err(io)?;
            let header = columns
                .iter()
                .map(|(name, _)| csv_field(Some(name)))
                .collect::<Vec<_>>()
                .join(",");
            out.write_all(format!("{header}\r\n").as_bytes()).await.map_err(io)?;
        }
        ExportFormat::Json => out.write_all(b"[").await.map_err(io)?,
        ExportFormat::Sql => {}
    }

    let mut rows: u64 = 0;
    while let Some(message) = stream.try_next().await.map_err(db::err)? {
        let SimpleQueryMessage::Row(row) = message else {
            continue;
        };
        let line = match format {
            ExportFormat::Csv => {
                let fields: Vec<String> = (0..columns.len()).map(|i| csv_field(row.get(i))).collect();
                format!("{}\r\n", fields.join(","))
            }
            ExportFormat::Json => {
                let fields: Vec<String> = columns
                    .iter()
                    .enumerate()
                    .map(|(i, (name, kind))| {
                        format!(
                            "{}:{}",
                            serde_json::Value::String(name.clone()),
                            json_value(row.get(i), *kind)
                        )
                    })
                    .collect();
                format!("{}\n  {{{}}}", if rows == 0 { "" } else { "," }, fields.join(","))
            }
            ExportFormat::Sql => {
                let values: Vec<String> = columns
                    .iter()
                    .enumerate()
                    .map(|(i, (_, kind))| sql_value(row.get(i), *kind))
                    .collect();
                format!("{insert_prefix}{});\n", values.join(", "))
            }
        };
        out.write_all(line.as_bytes()).await.map_err(io)?;
        rows += 1;
    }

    if format == ExportFormat::Json {
        out.write_all(if rows == 0 { b"]\n" as &[u8] } else { b"\n]\n" })
            .await
            .map_err(io)?;
    }
    out.flush().await.map_err(io)?;
    Ok(rows)
}

pub fn validate_path(path: &str, format: ExportFormat) -> Result<PathBuf, String> {
    let target = PathBuf::from(path);
    if !target.is_absolute() {
        return Err("La ruta de exportación debe ser absoluta.".to_string());
    }
    let extension = match format {
        ExportFormat::Csv => "csv",
        ExportFormat::Json => "json",
        ExportFormat::Sql => "sql",
    };
    match target.extension().and_then(|e| e.to_str()) {
        Some(e) if e.eq_ignore_ascii_case(extension) => {}
        _ => return Err(format!("El archivo de destino debe terminar en .{extension}.")),
    }
    if target.is_dir() {
        return Err("La ruta de destino es una carpeta, no un archivo.".to_string());
    }
    match target.parent() {
        Some(dir) if dir.is_dir() => Ok(target),
        _ => Err("La carpeta de destino no existe.".to_string()),
    }
}

pub async fn export_query(
    session: &Session,
    sql: &str,
    format: ExportFormat,
    path: &str,
    table_label: &str,
) -> Result<u64, String> {
    let path = validate_path(path, format)?;
    let statement = session.client.prepare(sql).await.map_err(db::err)?;
    let columns: Vec<(String, Kind)> = statement
        .columns()
        .iter()
        .map(|c| (c.name().to_string(), kind_of(c.type_())))
        .collect();
    if columns.is_empty() {
        return Err("La sentencia no devuelve filas, no hay nada que exportar.".to_string());
    }
    db::set_timeout(&session.client, 0).await?;

    let file = tokio::fs::File::create(&path)
        .await
        .map_err(|e| format!("No se pudo crear el archivo: {e}"))?;
    let mut out = BufWriter::new(file);
    match write_rows(session, sql, format, &columns, table_label, &mut out).await {
        Ok(rows) => Ok(rows),
        Err(e) => {
            drop(out);
            let _ = tokio::fs::remove_file(&path).await;
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_quotes_only_when_needed() {
        assert_eq!(csv_field(None), "");
        assert_eq!(csv_field(Some("plain")), "plain");
        assert_eq!(csv_field(Some("a,b")), "\"a,b\"");
        assert_eq!(csv_field(Some("say \"hi\"")), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field(Some("line\nbreak")), "\"line\nbreak\"");
    }

    #[test]
    fn export_paths_must_be_absolute_existing_and_match_the_format() {
        let dir = std::env::temp_dir();
        let ok = dir.join("salida.CSV");
        assert!(validate_path(ok.to_str().unwrap(), ExportFormat::Csv).is_ok());

        assert!(validate_path("relativo.csv", ExportFormat::Csv).unwrap_err().contains("absoluta"));
        assert!(validate_path("..\\..\\x.csv", ExportFormat::Csv).unwrap_err().contains("absoluta"));
        assert!(validate_path(dir.join("a.exe").to_str().unwrap(), ExportFormat::Csv)
            .unwrap_err()
            .contains(".csv"));
        assert!(validate_path(dir.join("a.csv").to_str().unwrap(), ExportFormat::Json)
            .unwrap_err()
            .contains(".json"));
        assert!(validate_path(dir.join("sin_extension").to_str().unwrap(), ExportFormat::Sql)
            .unwrap_err()
            .contains(".sql"));
        let missing = dir.join("hyrax-no-existe-xyz").join("a.csv");
        assert!(validate_path(missing.to_str().unwrap(), ExportFormat::Csv).unwrap_err().contains("no existe"));
        let folder_named_like_a_file = dir.join("hyrax-folder.csv");
        std::fs::create_dir_all(&folder_named_like_a_file).unwrap();
        assert!(validate_path(folder_named_like_a_file.to_str().unwrap(), ExportFormat::Csv)
            .unwrap_err()
            .contains("carpeta"));
        let _ = std::fs::remove_dir(&folder_named_like_a_file);
    }

    #[test]
    fn json_keeps_types() {
        assert_eq!(json_value(None, Kind::Text), "null");
        assert_eq!(json_value(Some("42"), Kind::Number), "42");
        assert_eq!(json_value(Some("2.50"), Kind::Number), "2.50");
        assert_eq!(json_value(Some("NaN"), Kind::Number), "\"NaN\"");
        assert_eq!(json_value(Some("t"), Kind::Bool), "true");
        assert_eq!(json_value(Some("f"), Kind::Bool), "false");
        assert_eq!(json_value(Some("{\"a\": 1}"), Kind::Json), "{\"a\":1}");
        assert_eq!(json_value(Some("007"), Kind::Text), "\"007\"");
        assert_eq!(json_value(Some("a\"b\\c"), Kind::Text), "\"a\\\"b\\\\c\"");
    }

    #[test]
    fn sql_literals_are_escaped() {
        assert_eq!(sql_value(None, Kind::Text), "NULL");
        assert_eq!(sql_value(Some("7"), Kind::Number), "7");
        assert_eq!(sql_value(Some("t"), Kind::Bool), "TRUE");
        assert_eq!(sql_value(Some("it's"), Kind::Text), "'it''s'");
        assert_eq!(sql_value(Some("a\\b"), Kind::Text), "E'a\\\\b'");
    }
}
