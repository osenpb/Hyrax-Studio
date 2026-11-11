use std::collections::HashSet;

use futures_util::future::join_all;
use tokio_postgres::types::ToSql;
use tokio_postgres::Client;

use crate::db::{self, Session};
use crate::edit::load_editable_columns;
use crate::models::{ColumnInfo, ImportResult};

pub const MAX_IMPORT_ROWS: usize = 200_000;
const PIPELINE: usize = 200;

pub fn resolve_columns<'a>(names: &[String], table: &'a [ColumnInfo]) -> Result<Vec<&'a ColumnInfo>, String> {
    if names.is_empty() {
        return Err("No hay columnas asignadas: elige al menos una columna de destino.".to_string());
    }
    let mut seen = HashSet::new();
    let mut found = Vec::with_capacity(names.len());
    for name in names {
        if !seen.insert(name.as_str()) {
            return Err(format!("La columna \"{name}\" está asignada más de una vez."));
        }
        let column = table
            .iter()
            .find(|c| &c.name == name)
            .ok_or_else(|| format!("La tabla no tiene la columna \"{name}\"."))?;
        found.push(column);
    }
    Ok(found)
}

pub fn check_rows(width: usize, rows: &[Vec<Option<String>>]) -> Result<(), String> {
    if rows.is_empty() {
        return Err("No hay filas que importar.".to_string());
    }
    if rows.len() > MAX_IMPORT_ROWS {
        return Err(format!(
            "Demasiadas filas para una sola importación ({}); el máximo es {MAX_IMPORT_ROWS}. Divide el archivo.",
            rows.len()
        ));
    }
    for (index, row) in rows.iter().enumerate() {
        if row.len() != width {
            return Err(format!(
                "La fila {} tiene {} valores y se esperaban {width}.",
                index + 1,
                row.len()
            ));
        }
        if row.iter().flatten().any(|v| v.contains('\0')) {
            return Err(format!(
                "La fila {} contiene un carácter nulo (NUL), que PostgreSQL no admite.",
                index + 1
            ));
        }
    }
    Ok(())
}

pub fn build_insert_sql(schema: &str, table: &str, columns: &[&ColumnInfo]) -> String {
    let names: Vec<String> = columns.iter().map(|c| db::quote_ident(&c.name)).collect();
    let values: Vec<String> = columns
        .iter()
        .enumerate()
        .map(|(i, c)| format!("${}::text::{}", i + 1, c.data_type))
        .collect();
    format!(
        "INSERT INTO {}.{} ({}) VALUES ({})",
        db::quote_ident(schema),
        db::quote_ident(table),
        names.join(", "),
        values.join(", ")
    )
}

async fn rollback(client: &Client) {
    if client.batch_execute("ROLLBACK").await.is_err() {
        let _ = client.batch_execute("ROLLBACK").await;
    }
}

pub async fn import_rows(
    session: &Session,
    schema: &str,
    table: &str,
    columns: &[String],
    rows: &[Vec<Option<String>>],
    dry_run: bool,
) -> Result<ImportResult, String> {
    if db::is_read_only(&session.client).await? {
        return Err("La sesión está en modo solo lectura. Habilita la escritura para importar.".to_string());
    }
    let table_columns = load_editable_columns(session, schema, table).await?;
    let targets = resolve_columns(columns, &table_columns)?;
    check_rows(columns.len(), rows)?;
    let sql = build_insert_sql(schema, table, &targets);
    let client = &session.client;

    client.batch_execute("BEGIN").await.map_err(db::err)?;
    if let Err(e) = client
        .batch_execute("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '300s'")
        .await
    {
        rollback(client).await;
        return Err(db::err(e));
    }
    let statement = match client.prepare(&sql).await {
        Ok(s) => s,
        Err(e) => {
            rollback(client).await;
            return Err(db::err(e));
        }
    };

    let mut inserted: u64 = 0;
    for (chunk_index, chunk) in rows.chunks(PIPELINE).enumerate() {
        let sets: Vec<Vec<&(dyn ToSql + Sync)>> = chunk
            .iter()
            .map(|row| row.iter().map(|v| v as &(dyn ToSql + Sync)).collect())
            .collect();
        let outcomes = join_all(sets.iter().map(|params| client.execute(&statement, params))).await;
        for (offset, outcome) in outcomes.into_iter().enumerate() {
            match outcome {
                Ok(1) => inserted += 1,
                Ok(n) => {
                    rollback(client).await;
                    return Err(format!(
                        "Fila {}: se esperaba insertar 1 fila y se insertaron {n}. No se importó nada.",
                        chunk_index * PIPELINE + offset + 1
                    ));
                }
                Err(e) => {
                    rollback(client).await;
                    return Err(format!(
                        "Fila {}: {}\nNo se importó nada.",
                        chunk_index * PIPELINE + offset + 1,
                        db::describe(&e)
                    ));
                }
            }
        }
    }

    if dry_run {
        rollback(client).await;
        return Ok(ImportResult {
            inserted,
            rolled_back: true,
        });
    }
    client
        .batch_execute("COMMIT")
        .await
        .map_err(|e| format!("No se pudo confirmar la transacción: {}", db::describe(&e)))?;
    Ok(ImportResult {
        inserted,
        rolled_back: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: ty.to_string(),
            nullable: true,
            default: None,
            is_primary_key: false,
        }
    }

    fn cells(rows: &[&[Option<&str>]]) -> Vec<Vec<Option<String>>> {
        rows.iter()
            .map(|r| r.iter().map(|v| v.map(str::to_string)).collect())
            .collect()
    }

    #[tokio::test]
    #[ignore]
    async fn imports_atomically_with_real_types_and_rolls_back_on_any_failure() {
        use crate::testing::{profile, run, value};
        let session = db::connect(&profile(false)).await.unwrap();
        run(
            &session,
            "DROP SCHEMA IF EXISTS pgdesk_imp CASCADE; CREATE SCHEMA pgdesk_imp; \
             CREATE TABLE pgdesk_imp.t (id int PRIMARY KEY, name text, price numeric(10,2), born date, meta jsonb, tags text[]); \
             CREATE TABLE pgdesk_imp.no_pk (a int, b text); \
             CREATE VIEW pgdesk_imp.v AS SELECT * FROM pgdesk_imp.t",
        )
        .await;
        let count = |table: &'static str| {
            let session = &session;
            async move { value(session, &format!("SELECT count(*) FROM pgdesk_imp.{table}")).await.unwrap() }
        };
        let columns: Vec<String> = ["id", "name", "price", "born", "meta", "tags"].iter().map(|s| s.to_string()).collect();

        // El ensayo inserta y revierte.
        let rows = cells(&[
            &[Some("1"), Some("Ana"), Some("10.50"), Some("2026-01-02"), Some("{\"a\": [1, 2]}"), Some("{x,\"y z\"}")],
            &[Some("2"), Some("O'Brien \\ \"q\""), None, None, None, None],
            &[Some("3"), Some(""), Some("0"), None, Some("[]"), Some("{}")],
        ]);
        let dry = import_rows(&session, "pgdesk_imp", "t", &columns, &rows, true).await.unwrap();
        assert_eq!((dry.inserted, dry.rolled_back), (3, true));
        assert_eq!(count("t").await, "0");

        // La importación real confirma y conserva comillas, barras, NULL y tipos.
        let real = import_rows(&session, "pgdesk_imp", "t", &columns, &rows, false).await.unwrap();
        assert_eq!((real.inserted, real.rolled_back), (3, false));
        assert_eq!(count("t").await, "3");
        assert_eq!(value(&session, "SELECT name FROM pgdesk_imp.t WHERE id = 2").await.as_deref(), Some("O'Brien \\ \"q\""));
        assert_eq!(value(&session, "SELECT price::text FROM pgdesk_imp.t WHERE id = 1").await.as_deref(), Some("10.50"));
        assert_eq!(value(&session, "SELECT meta->'a'->>1 FROM pgdesk_imp.t WHERE id = 1").await.as_deref(), Some("2"));
        assert_eq!(value(&session, "SELECT tags[2] FROM pgdesk_imp.t WHERE id = 1").await.as_deref(), Some("y z"));
        assert_eq!(value(&session, "SELECT price IS NULL FROM pgdesk_imp.t WHERE id = 2").await.as_deref(), Some("t"));
        assert_eq!(value(&session, "SELECT name = '' FROM pgdesk_imp.t WHERE id = 3").await.as_deref(), Some("t"));

        // Un valor inválido en la fila 3 no deja nada importado y el error dice qué fila fue.
        let bad = cells(&[
            &[Some("10"), Some("a"), Some("1"), None, None, None],
            &[Some("11"), Some("b"), Some("2"), None, None, None],
            &[Some("12"), Some("c"), Some("no es un número"), None, None, None],
        ]);
        let failed = import_rows(&session, "pgdesk_imp", "t", &columns, &bad, false).await.unwrap_err();
        assert!(failed.contains("Fila 3") && failed.contains("No se importó nada"), "{failed}");
        assert_eq!(count("t").await, "3");

        // Una clave duplicada también revierte todo, aunque la fila repetida llegue en medio de un lote.
        let dup = cells(&[
            &[Some("20"), None, None, None, None, None],
            &[Some("1"), None, None, None, None, None],
        ]);
        let failed = import_rows(&session, "pgdesk_imp", "t", &columns, &dup, false).await.unwrap_err();
        let lower = failed.to_lowercase();
        assert!(failed.contains("Fila 2") && (lower.contains("duplicate") || lower.contains("duplicad")), "{failed}");
        assert_eq!(count("t").await, "3");

        // Un subconjunto de columnas deja el resto con su valor por defecto; una tabla sin PK también sirve.
        let subset = vec!["id".to_string(), "name".to_string()];
        import_rows(&session, "pgdesk_imp", "t", &subset, &cells(&[&[Some("30"), Some("solo nombre")]]), false).await.unwrap();
        let loose = vec!["a".to_string(), "b".to_string()];
        import_rows(&session, "pgdesk_imp", "no_pk", &loose, &cells(&[&[Some("1"), Some("x")], &[Some("1"), Some("x")]]), false).await.unwrap();
        assert_eq!(count("no_pk").await, "2");

        // Un lote grande avanza en tandas encadenadas y respeta el orden de los errores.
        let many: Vec<Vec<Option<String>>> = (1000..6000).map(|i| vec![Some(i.to_string()), Some(format!("n{i}"))]).collect();
        let big = import_rows(&session, "pgdesk_imp", "t", &subset, &many, false).await.unwrap();
        assert_eq!(big.inserted, 5000);
        assert_eq!(count("t").await, "5004");
        let mut late_failure = many.clone();
        late_failure.iter_mut().for_each(|r| r[0] = Some((10_000 + r[0].as_ref().unwrap().parse::<i32>().unwrap()).to_string()));
        late_failure[777][0] = Some("not a number".to_string());
        let failed = import_rows(&session, "pgdesk_imp", "t", &subset, &late_failure, false).await.unwrap_err();
        assert!(failed.contains("Fila 778"), "{failed}");
        assert_eq!(count("t").await, "5004");

        // Rechazos: vistas, columnas inexistentes o repetidas, sesión de solo lectura.
        let view = import_rows(&session, "pgdesk_imp", "v", &subset, &cells(&[&[Some("1"), Some("x")]]), false).await.unwrap_err();
        assert!(view.contains("vistas"), "{view}");
        let unknown = vec!["id".to_string(), "nope".to_string()];
        assert!(import_rows(&session, "pgdesk_imp", "t", &unknown, &cells(&[&[Some("1"), Some("x")]]), false).await.unwrap_err().contains("nope"));
        let sys = import_rows(&session, "pg_catalog", "pg_class", &subset, &cells(&[&[Some("1"), Some("x")]]), false).await.unwrap_err();
        assert!(sys.contains("sistema"), "{sys}");
        let read_only = db::connect(&profile(true)).await.unwrap();
        let refused = import_rows(&read_only, "pgdesk_imp", "t", &subset, &cells(&[&[Some("1"), Some("x")]]), true).await.unwrap_err();
        assert!(refused.contains("solo lectura"), "{refused}");

        run(&session, "DROP SCHEMA pgdesk_imp CASCADE").await;
    }

    #[test]
    fn builds_a_typed_parameterised_insert() {
        let table = vec![col("id", "bigint"), col("na\"me", "character varying(20)")];
        let targets = resolve_columns(&["id".to_string(), "na\"me".to_string()], &table).unwrap();
        assert_eq!(
            build_insert_sql("public", "t", &targets),
            "INSERT INTO \"public\".\"t\" (\"id\", \"na\"\"me\") VALUES ($1::text::bigint, $2::text::character varying(20))"
        );
    }

    #[test]
    fn rejects_unknown_duplicate_and_empty_column_maps() {
        let table = vec![col("id", "integer")];
        assert!(resolve_columns(&[], &table).unwrap_err().contains("al menos una"));
        assert!(resolve_columns(&["x".to_string()], &table).unwrap_err().contains("\"x\""));
        let dup = resolve_columns(&["id".to_string(), "id".to_string()], &table).unwrap_err();
        assert!(dup.contains("más de una vez"), "{dup}");
    }

    #[test]
    fn validates_row_shape_size_and_nul() {
        assert!(check_rows(2, &[]).is_err());
        assert!(check_rows(2, &[vec![Some("a".into()), None]]).is_ok());
        let short = check_rows(2, &[vec![Some("a".into()), None], vec![None]]).unwrap_err();
        assert!(short.contains("fila 2"), "{short}");
        let nul = check_rows(1, &[vec![Some("a\0b".into())]]).unwrap_err();
        assert!(nul.contains("NUL"), "{nul}");
        let many = vec![vec![None]; MAX_IMPORT_ROWS + 1];
        assert!(check_rows(1, &many).unwrap_err().contains("Demasiadas"));
    }
}
