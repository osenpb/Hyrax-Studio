//! Validación y conversión de las consultas de MongoDB (lógica pura, sin servidor).
//!
//! Hyrax no ejecuta JavaScript: se rechazan los operadores que lo permiten en el servidor, y los filtros llegan
//! como JSON extendido, que se convierte a BSON sin pasar por ningún evaluador.

use std::time::Duration;

use mongodb::bson::{Bson, Document};

/// Operadores que ejecutan JavaScript en el servidor o escriben desde una agregación.
const FORBIDDEN: [&str; 5] = ["$where", "$function", "$accumulator", "$out", "$merge"];

const MAX_TEXT: usize = 256 * 1024;
pub const MAX_LIMIT: i64 = 200;
pub const MAX_SKIP: u64 = 1_000_000;
pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
pub const PROD_MAX_TIMEOUT_MS: u64 = 5 * 60_000;
/// Tope de bytes de documentos que se devuelven en una página.
pub const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;

fn scan(value: &serde_json::Value, found: &mut Option<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                if FORBIDDEN.iter().any(|f| f.eq_ignore_ascii_case(k)) && found.is_none() {
                    *found = Some(k.clone());
                }
                scan(v, found);
            }
        }
        serde_json::Value::Array(items) => items.iter().for_each(|v| scan(v, found)),
        _ => {}
    }
}

/// Convierte el texto (JSON extendido) en un documento BSON. Vacío = documento vacío.
pub fn parse_document(text: &str, what: &str) -> Result<Document, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(Document::new());
    }
    if text.len() > MAX_TEXT {
        return Err(format!("{what} es demasiado largo."));
    }
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("{what} no es JSON válido: {e}"))?;
    if !value.is_object() {
        return Err(format!("{what} debe ser un objeto JSON, por ejemplo {{ \"campo\": \"valor\" }}."));
    }
    let mut found = None;
    scan(&value, &mut found);
    if let Some(op) = found {
        return Err(format!(
            "{what} usa {op}, que Hyrax no permite: ejecuta JavaScript en el servidor o escribe datos."
        ));
    }
    match Bson::try_from(value).map_err(|e| format!("{what} tiene un tipo no válido: {e}"))? {
        Bson::Document(doc) => Ok(doc),
        _ => Err(format!("{what} debe ser un objeto JSON.")),
    }
}

/// Máximo de etapas de un pipeline (evita pipelines absurdos pegados por error).
pub const MAX_STAGES: usize = 50;

/// Convierte el texto (un arreglo JSON extendido de etapas) en un pipeline. Cada etapa debe ser un objeto con
/// una sola clave que empiece por `$`; se rechazan las etapas y operadores que escriben o ejecutan JavaScript.
pub fn parse_pipeline(text: &str) -> Result<Vec<Document>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("El pipeline está vacío. Escribe un arreglo con al menos una etapa.".to_string());
    }
    if text.len() > MAX_TEXT {
        return Err("El pipeline es demasiado largo.".to_string());
    }
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("El pipeline no es JSON válido: {e}"))?;
    let stages = value
        .as_array()
        .ok_or_else(|| "El pipeline debe ser un arreglo de etapas entre corchetes.".to_string())?;
    if stages.is_empty() {
        return Err("El pipeline no tiene etapas.".to_string());
    }
    if stages.len() > MAX_STAGES {
        return Err(format!("El pipeline tiene más de {MAX_STAGES} etapas."));
    }
    let mut found = None;
    scan(&value, &mut found);
    if let Some(op) = found {
        return Err(format!(
            "El pipeline usa {op}, que Hyrax no permite: ejecuta JavaScript en el servidor o escribe datos."
        ));
    }
    let mut out = Vec::with_capacity(stages.len());
    for (i, stage) in stages.iter().enumerate() {
        let n = i + 1;
        let obj = stage
            .as_object()
            .filter(|o| o.len() == 1 && o.keys().all(|k| k.starts_with('$')))
            .ok_or_else(|| format!("La etapa {n} debe ser un objeto con un solo operador que empiece por $, como $match."))?;
        let name = obj.keys().next().cloned().unwrap_or_default();
        if name == "$collStats" || name == "$currentOp" || name == "$listSessions" || name == "$planCacheStats" {
            return Err(format!("La etapa {n} ({name}) no está disponible en la consola."));
        }
        match Bson::try_from(stage.clone()).map_err(|e| format!("La etapa {n} tiene un tipo no válido: {e}"))? {
            Bson::Document(d) => out.push(d),
            _ => return Err(format!("La etapa {n} debe ser un objeto.")),
        }
    }
    Ok(out)
}

/// El orden solo admite `1` o `-1` por campo.
pub fn validate_sort(sort: &Document) -> Result<(), String> {
    for (field, direction) in sort {
        let ok = match direction {
            Bson::Int32(n) => *n == 1 || *n == -1,
            Bson::Int64(n) => *n == 1 || *n == -1,
            Bson::Double(n) => *n == 1.0 || *n == -1.0,
            _ => false,
        };
        if !ok {
            return Err(format!("El orden de «{field}» debe ser 1 (ascendente) o -1 (descendente)."));
        }
    }
    Ok(())
}

pub fn clamp_limit(limit: i64) -> i64 {
    limit.clamp(1, MAX_LIMIT)
}

pub fn clamp_skip(skip: u64) -> u64 {
    skip.min(MAX_SKIP)
}

/// Tiempo máximo por consulta: el pedido (o el predeterminado), con tope menor en producción.
pub fn effective_timeout(requested_ms: u64, production: bool) -> Duration {
    let cap = if production { PROD_MAX_TIMEOUT_MS } else { 10 * 60_000 };
    let ms = if requested_ms == 0 { DEFAULT_TIMEOUT_MS } else { requested_ms };
    Duration::from_millis(ms.min(cap))
}

/// Nombre de base de datos: sin los caracteres que MongoDB prohíbe.
pub fn validate_database(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 63 || name.chars().any(|c| "/\\. \"$*<>:|?\0".contains(c)) {
        return Err("El nombre de la base de datos no es válido.".to_string());
    }
    Ok(())
}

pub fn validate_collection(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 255 || name.contains('$') || name.contains('\0') {
        return Err("El nombre de la colección no es válido.".to_string());
    }
    Ok(())
}

/// Documento → JSON extendido canónico (conserva Int32/Int64/Double, ObjectId, Date, Decimal128…).
pub fn to_canonical(doc: Document) -> String {
    Bson::Document(doc).into_canonical_extjson().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::{doc, oid::ObjectId};

    #[test]
    fn empty_text_is_an_empty_document_and_objects_parse() {
        assert!(parse_document("", "El filtro").unwrap().is_empty());
        assert!(parse_document("   ", "El filtro").unwrap().is_empty());
        let d = parse_document(r#"{"status":"OPEN","n":{"$gt":5}}"#, "El filtro").unwrap();
        assert_eq!(d.get_str("status").unwrap(), "OPEN");
    }

    #[test]
    fn extended_json_types_become_real_bson_types() {
        let d = parse_document(
            r#"{"_id":{"$oid":"507f1f77bcf86cd799439011"},"at":{"$date":"2026-03-01T00:00:00Z"},"n":{"$numberLong":"5"}}"#,
            "El filtro",
        )
        .unwrap();
        assert!(matches!(d.get("_id"), Some(Bson::ObjectId(_))));
        assert!(matches!(d.get("at"), Some(Bson::DateTime(_))));
        assert!(matches!(d.get("n"), Some(Bson::Int64(5))));
    }

    #[test]
    fn javascript_and_write_operators_are_rejected_anywhere() {
        for bad in [
            r#"{"$where":"this.a == 1"}"#,
            r#"{"a":{"$function":{"body":"function(){}","args":[],"lang":"js"}}}"#,
            r#"{"$and":[{"x":1},{"$where":"1"}]}"#,
            r#"{"a":[{"b":{"$accumulator":{}}}]}"#,
            r#"{"$OUT":"x"}"#,
            r#"{"$merge":{"into":"x"}}"#,
        ] {
            let err = parse_document(bad, "El filtro").unwrap_err();
            assert!(err.contains("no permite"), "{bad}: {err}");
        }
        // Un campo normal que contiene la palabra no se confunde con el operador.
        assert!(parse_document(r#"{"where":"x","outbound":1}"#, "El filtro").is_ok());
    }

    #[test]
    fn invalid_json_and_non_objects_are_explained() {
        assert!(parse_document("{", "El filtro").unwrap_err().contains("JSON válido"));
        assert!(parse_document("[1,2]", "El filtro").unwrap_err().contains("objeto"));
        assert!(parse_document("5", "El filtro").unwrap_err().contains("objeto"));
        let huge = format!("{{\"a\":\"{}\"}}", "x".repeat(300_000));
        assert!(parse_document(&huge, "El filtro").unwrap_err().contains("demasiado largo"));
    }

    #[test]
    fn pipelines_are_parsed_stage_by_stage_and_unsafe_ones_rejected() {
        let p = parse_pipeline(r#"[{"$match":{"a":1}},{"$group":{"_id":"$b","n":{"$sum":1}}}]"#).unwrap();
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].keys().next().unwrap(), "$match");
        assert!(parse_pipeline("").unwrap_err().contains("vacío"));
        assert!(parse_pipeline("[]").unwrap_err().contains("no tiene etapas"));
        assert!(parse_pipeline(r#"{"$match":{}}"#).unwrap_err().contains("arreglo"));
        assert!(parse_pipeline("[").unwrap_err().contains("JSON válido"));
        assert!(parse_pipeline(r#"[{"match":{}}]"#).unwrap_err().contains("etapa 1"));
        assert!(parse_pipeline(r#"[{"$match":{},"$limit":1}]"#).unwrap_err().contains("etapa 1"));
        assert!(parse_pipeline(r#"[1]"#).unwrap_err().contains("etapa 1"));
        for bad in [
            r#"[{"$out":"x"}]"#,
            r#"[{"$match":{}},{"$merge":{"into":"x"}}]"#,
            r#"[{"$match":{"$expr":{"$function":{"body":"x","args":[],"lang":"js"}}}}]"#,
            r#"[{"$group":{"_id":1,"v":{"$accumulator":{}}}}]"#,
            r#"[{"$lookup":{"from":"b","pipeline":[{"$out":"z"}],"as":"r"}}]"#,
        ] {
            assert!(parse_pipeline(bad).unwrap_err().contains("no permite"), "{bad}");
        }
        assert!(parse_pipeline(r#"[{"$collStats":{}}]"#).unwrap_err().contains("no está disponible"));
        let many = format!("[{}]", vec![r#"{"$match":{}}"#; MAX_STAGES + 1].join(","));
        assert!(parse_pipeline(&many).unwrap_err().contains("más de"));
    }

    #[test]
    fn sort_only_accepts_one_or_minus_one() {
        assert!(validate_sort(&doc! {"a": 1, "b": -1}).is_ok());
        assert!(validate_sort(&doc! {"a": 1.0}).is_ok());
        assert!(validate_sort(&doc! {"a": 0}).is_err());
        assert!(validate_sort(&doc! {"a": 2}).is_err());
        assert!(validate_sort(&doc! {"a": "asc"}).is_err());
        assert!(validate_sort(&doc! {"a": {"$meta": "textScore"}}).is_err());
    }

    #[test]
    fn limits_skip_and_timeouts_are_capped() {
        assert_eq!(clamp_limit(0), 1);
        assert_eq!(clamp_limit(50), 50);
        assert_eq!(clamp_limit(10_000), MAX_LIMIT);
        assert_eq!(clamp_skip(5_000_000), MAX_SKIP);
        assert_eq!(effective_timeout(0, false), Duration::from_millis(DEFAULT_TIMEOUT_MS));
        assert_eq!(effective_timeout(30_000, true), Duration::from_millis(30_000));
        assert_eq!(effective_timeout(u64::MAX, true), Duration::from_millis(PROD_MAX_TIMEOUT_MS));
        assert_eq!(effective_timeout(u64::MAX, false), Duration::from_millis(600_000));
    }

    #[test]
    fn names_are_validated() {
        assert!(validate_database("ventas").is_ok());
        for bad in ["", "a b", "a.b", "a/b", "a$b", "a\"b"] {
            assert!(validate_database(bad).is_err(), "{bad}");
        }
        assert!(validate_collection("orders.items").is_ok());
        assert!(validate_collection("a$b").is_err());
        assert!(validate_collection("").is_err());
    }

    #[test]
    fn key_order_is_preserved_when_reading_and_writing() {
        // El orden de un sort con varios campos importa: {"b":1,"a":-1} no es lo mismo que {"a":-1,"b":1}.
        let sort = parse_document(r#"{"b":1,"a":-1,"c":1}"#, "El orden").unwrap();
        assert_eq!(sort.keys().map(String::as_str).collect::<Vec<_>>(), ["b", "a", "c"]);

        // Un documento sale en el orden en que MongoDB lo guardó (con _id donde esté), no alfabético.
        let text = to_canonical(doc! {"zeta": 1, "_id": 2, "alfa": 3});
        let (z, id, a) = (text.find("zeta").unwrap(), text.find("_id").unwrap(), text.find("alfa").unwrap());
        assert!(z < id && id < a, "{text}");
        let first = to_canonical(doc! {"_id": 1, "alfa": 2, "zeta": 3});
        assert!(first.find("_id").unwrap() < first.find("alfa").unwrap(), "{first}");
    }

    #[test]
    fn canonical_output_keeps_the_bson_types() {
        let id = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
        let text = to_canonical(doc! {"_id": id, "n": 5_i32, "big": 5_i64, "x": 1.5});
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["_id"]["$oid"], "507f1f77bcf86cd799439011");
        assert_eq!(v["n"]["$numberInt"], "5");
        assert_eq!(v["big"]["$numberLong"], "5");
        assert_eq!(v["x"]["$numberDouble"], "1.5");
    }
}
