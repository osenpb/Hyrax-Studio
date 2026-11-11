use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use tokio_postgres::types::ToSql;

use crate::db::{self, Session};
use crate::models::ColumnInfo;

pub const MAX_CHANGES: usize = 5000;

#[derive(Clone, Debug, Default, Deserialize)]
pub struct RowUpdate {
    pub pk: BTreeMap<String, String>,
    pub original: BTreeMap<String, Option<String>>,
    pub set: BTreeMap<String, Option<String>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct RowDelete {
    pub pk: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum InsertValue {
    Default,
    Null,
    Value { value: String },
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct RowInsert {
    pub values: BTreeMap<String, InsertValue>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ChangeSet {
    #[serde(default)]
    pub updates: Vec<RowUpdate>,
    #[serde(default)]
    pub deletes: Vec<RowDelete>,
    #[serde(default)]
    pub inserts: Vec<RowInsert>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ApplyResult {
    pub updated: u64,
    pub deleted: u64,
    pub inserted: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    Update,
    Delete,
    Insert,
}

#[derive(Clone, Debug)]
pub struct Planned {
    pub kind: ChangeKind,
    pub sql: String,
    pub display: String,
    pub params: Vec<Option<String>>,
}

struct Builder {
    sql: String,
    display: String,
    params: Vec<Option<String>>,
}

impl Builder {
    fn new() -> Self {
        Builder {
            sql: String::new(),
            display: String::new(),
            params: Vec::new(),
        }
    }

    fn text(&mut self, text: &str) {
        self.sql.push_str(text);
        self.display.push_str(text);
    }

    fn push_param(&mut self, value: Option<&str>) -> usize {
        self.params.push(value.map(str::to_string));
        self.params.len()
    }

    fn typed(&mut self, value: Option<&str>, ty: &str) {
        let n = self.push_param(value);
        self.sql.push_str(&format!("${n}::text::{ty}"));
        match value {
            Some(v) => self.display.push_str(&format!("{}::{ty}", db::quote_literal(v))),
            None => self.display.push_str(&format!("NULL::{ty}")),
        }
    }

    fn unchanged(&mut self, column: &str, value: Option<&str>, ty: &str) {
        let n = self.push_param(value);
        self.sql.push_str(&format!(
            "ROW({column})::text IS NOT DISTINCT FROM ROW(${n}::text::{ty})::text"
        ));
        match value {
            Some(v) => self.display.push_str(&format!(
                "{column} IS NOT DISTINCT FROM {}::{ty}",
                db::quote_literal(v)
            )),
            None => self
                .display
                .push_str(&format!("{column} IS NOT DISTINCT FROM NULL::{ty}")),
        }
    }

    fn finish(self, kind: ChangeKind) -> Planned {
        Planned {
            kind,
            sql: self.sql,
            display: self.display,
            params: self.params,
        }
    }
}

fn check_value(value: &str) -> Result<(), String> {
    if value.contains('\0') {
        Err("Un valor contiene un carácter nulo (NUL), que PostgreSQL no admite.".to_string())
    } else {
        Ok(())
    }
}

fn find<'a>(columns: &'a [ColumnInfo], name: &str) -> Result<&'a ColumnInfo, String> {
    columns
        .iter()
        .find(|c| c.name == name)
        .ok_or_else(|| format!("La columna \"{name}\" no existe en la tabla."))
}

fn check_pk(pk_columns: &[&ColumnInfo], pk: &BTreeMap<String, String>) -> Result<(), String> {
    let expected: BTreeSet<&str> = pk_columns.iter().map(|c| c.name.as_str()).collect();
    let given: BTreeSet<&str> = pk.keys().map(String::as_str).collect();
    if expected != given {
        return Err("La clave primaria de la fila no coincide con la de la tabla.".to_string());
    }
    for value in pk.values() {
        check_value(value)?;
    }
    Ok(())
}

fn where_pk(b: &mut Builder, pk_columns: &[&ColumnInfo], pk: &BTreeMap<String, String>) {
    for (i, col) in pk_columns.iter().enumerate() {
        b.text(if i == 0 { " WHERE " } else { " AND " });
        b.text(&db::quote_ident(&col.name));
        b.text(" = ");
        b.typed(pk.get(&col.name).map(String::as_str), &col.data_type);
    }
}

pub fn plan(
    schema: &str,
    table: &str,
    columns: &[ColumnInfo],
    changes: &ChangeSet,
) -> Result<Vec<Planned>, String> {
    let total = changes.updates.len() + changes.deletes.len() + changes.inserts.len();
    if total == 0 {
        return Err("No hay cambios que aplicar.".to_string());
    }
    if total > MAX_CHANGES {
        return Err(format!("Demasiados cambios a la vez ({total}); el máximo es {MAX_CHANGES}."));
    }
    let pk_columns: Vec<&ColumnInfo> = columns.iter().filter(|c| c.is_primary_key).collect();
    if pk_columns.is_empty() {
        return Err("La tabla no tiene clave primaria: no se puede editar de forma segura.".to_string());
    }
    let target = format!("{}.{}", db::quote_ident(schema), db::quote_ident(table));
    let mut plans = Vec::with_capacity(total);

    for update in &changes.updates {
        check_pk(&pk_columns, &update.pk)?;
        if update.set.is_empty() {
            return Err("Una actualización no cambia ninguna columna.".to_string());
        }
        let mut b = Builder::new();
        b.text(&format!("UPDATE {target} SET "));
        for (i, (name, value)) in update.set.iter().enumerate() {
            let col = find(columns, name)?;
            if col.is_primary_key {
                return Err(format!("No se puede modificar la columna de clave primaria \"{name}\"."));
            }
            if let Some(v) = value {
                check_value(v)?;
            }
            if i > 0 {
                b.text(", ");
            }
            b.text(&db::quote_ident(name));
            b.text(" = ");
            b.typed(value.as_deref(), &col.data_type);
        }
        where_pk(&mut b, &pk_columns, &update.pk);
        for name in update.set.keys() {
            let original = update
                .original
                .get(name)
                .ok_or_else(|| format!("Falta el valor original de \"{name}\" para comprobar cambios concurrentes."))?;
            let col = find(columns, name)?;
            b.text(" AND ");
            b.unchanged(&db::quote_ident(name), original.as_deref(), &col.data_type);
        }
        plans.push(b.finish(ChangeKind::Update));
    }

    for delete in &changes.deletes {
        check_pk(&pk_columns, &delete.pk)?;
        let mut b = Builder::new();
        b.text(&format!("DELETE FROM {target}"));
        where_pk(&mut b, &pk_columns, &delete.pk);
        plans.push(b.finish(ChangeKind::Delete));
    }

    for insert in &changes.inserts {
        let mut explicit: Vec<(&ColumnInfo, Option<&str>)> = Vec::new();
        for (name, value) in &insert.values {
            let col = find(columns, name)?;
            match value {
                InsertValue::Default => {}
                InsertValue::Null => explicit.push((col, None)),
                InsertValue::Value { value } => {
                    check_value(value)?;
                    explicit.push((col, Some(value.as_str())));
                }
            }
        }
        let mut b = Builder::new();
        if explicit.is_empty() {
            b.text(&format!("INSERT INTO {target} DEFAULT VALUES"));
        } else {
            b.text(&format!("INSERT INTO {target} ("));
            for (i, (col, _)) in explicit.iter().enumerate() {
                if i > 0 {
                    b.text(", ");
                }
                b.text(&db::quote_ident(&col.name));
            }
            b.text(") VALUES (");
            for (i, (col, value)) in explicit.iter().enumerate() {
                if i > 0 {
                    b.text(", ");
                }
                b.typed(*value, &col.data_type);
            }
            b.text(")");
        }
        plans.push(b.finish(ChangeKind::Insert));
    }
    Ok(plans)
}

pub fn preview(plans: &[Planned]) -> Vec<String> {
    plans.iter().map(|p| format!("{};", p.display)).collect()
}

fn describe_mismatch(kind: ChangeKind, count: u64) -> String {
    match (kind, count) {
        (ChangeKind::Update, 0) => {
            "La fila ya no existe o cambió desde que se cargó (otra persona la modificó). Actualiza la tabla y repite el cambio.".to_string()
        }
        (ChangeKind::Delete, 0) => "La fila ya no existe. Actualiza la tabla.".to_string(),
        (_, n) => format!("Se esperaba afectar 1 fila y se afectaron {n}."),
    }
}

pub async fn load_editable_columns(session: &Session, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    if schema.starts_with("pg_") || schema == "information_schema" {
        return Err("Las tablas del sistema no se pueden editar.".to_string());
    }
    let rows = session
        .client
        .query(
            "SELECT c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &table],
        )
        .await
        .map_err(db::err)?;
    let kind: String = rows
        .first()
        .map(|r| r.get(0))
        .ok_or_else(|| "La tabla no existe.".to_string())?;
    if kind != "r" && kind != "p" {
        return Err("Solo se pueden editar tablas, no vistas ni tablas foráneas.".to_string());
    }
    db::list_columns(&session.client, schema, table).await
}

pub async fn preview_changes(
    session: &Session,
    schema: &str,
    table: &str,
    changes: &ChangeSet,
) -> Result<Vec<String>, String> {
    let columns = load_editable_columns(session, schema, table).await?;
    Ok(preview(&plan(schema, table, &columns, changes)?))
}

pub async fn apply_changes(
    session: &Session,
    schema: &str,
    table: &str,
    changes: &ChangeSet,
) -> Result<ApplyResult, String> {
    if db::is_read_only(&session.client).await? {
        return Err("La sesión está en modo solo lectura. Habilita la escritura para aplicar cambios.".to_string());
    }
    let columns = load_editable_columns(session, schema, table).await?;
    let plans = plan(schema, table, &columns, changes)?;
    let client = &session.client;

    client.batch_execute("BEGIN").await.map_err(db::err)?;
    if let Err(e) = client
        .batch_execute("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '60s'")
        .await
    {
        let _ = client.batch_execute("ROLLBACK").await;
        return Err(db::err(e));
    }

    let mut result = ApplyResult {
        updated: 0,
        deleted: 0,
        inserted: 0,
    };
    for (index, planned) in plans.iter().enumerate() {
        let params: Vec<&(dyn ToSql + Sync)> = planned.params.iter().map(|p| p as &(dyn ToSql + Sync)).collect();
        match client.execute(&planned.sql, &params).await {
            Ok(1) => match planned.kind {
                ChangeKind::Update => result.updated += 1,
                ChangeKind::Delete => result.deleted += 1,
                ChangeKind::Insert => result.inserted += 1,
            },
            Ok(n) => {
                let _ = client.batch_execute("ROLLBACK").await;
                return Err(format!(
                    "Cambio {} de {}: {} No se aplicó ningún cambio.",
                    index + 1,
                    plans.len(),
                    describe_mismatch(planned.kind, n)
                ));
            }
            Err(e) => {
                let _ = client.batch_execute("ROLLBACK").await;
                return Err(format!(
                    "Cambio {} de {}: {}\nNo se aplicó ningún cambio.",
                    index + 1,
                    plans.len(),
                    db::describe(&e)
                ));
            }
        }
    }
    client.batch_execute("COMMIT").await.map_err(|e| {
        format!("No se pudo confirmar la transacción: {}", db::describe(&e))
    })?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str, pk: bool) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: ty.to_string(),
            nullable: !pk,
            default: None,
            is_primary_key: pk,
        }
    }

    fn people() -> Vec<ColumnInfo> {
        vec![
            col("id", "integer", true),
            col("name", "text", false),
            col("price", "numeric(10,2)", false),
        ]
    }

    fn map<V: Clone>(pairs: &[(&str, V)]) -> BTreeMap<String, V> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn update_is_parameterized_typed_and_checks_the_original_value() {
        let changes = ChangeSet {
            updates: vec![RowUpdate {
                pk: map(&[("id", "7".to_string())]),
                original: map(&[("name", Some("old".to_string())), ("price", None)]),
                set: map(&[("name", Some("it's".to_string())), ("price", Some("3.50".to_string()))]),
            }],
            ..ChangeSet::default()
        };
        let plans = plan("public", "people", &people(), &changes).unwrap();
        assert_eq!(plans.len(), 1);
        let p = &plans[0];
        assert_eq!(
            p.sql,
            "UPDATE \"public\".\"people\" SET \"name\" = $1::text::text, \"price\" = $2::text::numeric(10,2) \
             WHERE \"id\" = $3::text::integer \
             AND ROW(\"name\")::text IS NOT DISTINCT FROM ROW($4::text::text)::text \
             AND ROW(\"price\")::text IS NOT DISTINCT FROM ROW($5::text::numeric(10,2))::text"
        );
        assert_eq!(
            p.params,
            vec![
                Some("it's".to_string()),
                Some("3.50".to_string()),
                Some("7".to_string()),
                Some("old".to_string()),
                None
            ]
        );
        assert!(p.display.contains("'it''s'::text"));
        assert!(p.display.contains("\"price\" IS NOT DISTINCT FROM NULL::numeric(10,2)"));
        assert!(!p.sql.contains("it's"));
    }

    #[test]
    fn delete_and_insert_statements() {
        let changes = ChangeSet {
            deletes: vec![RowDelete { pk: map(&[("id", "1".to_string())]) }],
            inserts: vec![
                RowInsert {
                    values: map(&[
                        ("name", InsertValue::Value { value: "Eve".to_string() }),
                        ("price", InsertValue::Null),
                        ("id", InsertValue::Default),
                    ]),
                },
                RowInsert { values: map(&[("name", InsertValue::Default)]) },
            ],
            ..ChangeSet::default()
        };
        let plans = plan("public", "people", &people(), &changes).unwrap();
        assert_eq!(plans[0].sql, "DELETE FROM \"public\".\"people\" WHERE \"id\" = $1::text::integer");
        assert_eq!(
            plans[1].sql,
            "INSERT INTO \"public\".\"people\" (\"name\", \"price\") VALUES ($1::text::text, $2::text::numeric(10,2))"
        );
        assert_eq!(plans[1].params, vec![Some("Eve".to_string()), None]);
        assert_eq!(plans[2].sql, "INSERT INTO \"public\".\"people\" DEFAULT VALUES");
        assert_eq!(preview(&plans).len(), 3);
    }

    #[test]
    fn composite_keys_need_every_key_column() {
        let columns = vec![col("a", "integer", true), col("b", "text", true), col("note", "text", false)];
        let ok = ChangeSet {
            deletes: vec![RowDelete { pk: map(&[("a", "1".to_string()), ("b", "x".to_string())]) }],
            ..ChangeSet::default()
        };
        let plans = plan("public", "pairs", &columns, &ok).unwrap();
        assert_eq!(
            plans[0].sql,
            "DELETE FROM \"public\".\"pairs\" WHERE \"a\" = $1::text::integer AND \"b\" = $2::text::text"
        );
        let partial = ChangeSet {
            deletes: vec![RowDelete { pk: map(&[("a", "1".to_string())]) }],
            ..ChangeSet::default()
        };
        assert!(plan("public", "pairs", &columns, &partial).is_err());
    }

    #[test]
    fn rejects_unsafe_or_malformed_change_sets() {
        let none = ChangeSet::default();
        assert!(plan("public", "people", &people(), &none).unwrap_err().contains("No hay cambios"));

        let no_pk = vec![col("x", "integer", false)];
        let del = ChangeSet {
            deletes: vec![RowDelete { pk: BTreeMap::new() }],
            ..ChangeSet::default()
        };
        assert!(plan("public", "nopk", &no_pk, &del).unwrap_err().contains("clave primaria"));

        let pk_edit = ChangeSet {
            updates: vec![RowUpdate {
                pk: map(&[("id", "1".to_string())]),
                original: map(&[("id", Some("1".to_string()))]),
                set: map(&[("id", Some("2".to_string()))]),
            }],
            ..ChangeSet::default()
        };
        assert!(plan("public", "people", &people(), &pk_edit).unwrap_err().contains("clave primaria"));

        let unknown_col = ChangeSet {
            updates: vec![RowUpdate {
                pk: map(&[("id", "1".to_string())]),
                original: map(&[("nope", None)]),
                set: map(&[("nope", Some("x".to_string()))]),
            }],
            ..ChangeSet::default()
        };
        assert!(plan("public", "people", &people(), &unknown_col).unwrap_err().contains("no existe"));

        let missing_original = ChangeSet {
            updates: vec![RowUpdate {
                pk: map(&[("id", "1".to_string())]),
                original: BTreeMap::new(),
                set: map(&[("name", Some("x".to_string()))]),
            }],
            ..ChangeSet::default()
        };
        assert!(plan("public", "people", &people(), &missing_original).unwrap_err().contains("valor original"));

        let nul = ChangeSet {
            inserts: vec![RowInsert {
                values: map(&[("name", InsertValue::Value { value: "a\0b".to_string() })]),
            }],
            ..ChangeSet::default()
        };
        assert!(plan("public", "people", &people(), &nul).unwrap_err().contains("NUL"));

        let too_many = ChangeSet {
            inserts: vec![RowInsert::default(); MAX_CHANGES + 1],
            ..ChangeSet::default()
        };
        assert!(plan("public", "people", &people(), &too_many).unwrap_err().contains("Demasiados"));
    }

    #[test]
    fn change_sets_deserialize_from_the_frontend_shape() {
        let json = r#"{
            "updates": [{"pk": {"id": "1"}, "original": {"name": null}, "set": {"name": "x"}}],
            "deletes": [{"pk": {"id": "2"}}],
            "inserts": [{"values": {"name": {"mode": "value", "value": "v"}, "age": {"mode": "null"}, "id": {"mode": "default"}}}]
        }"#;
        let parsed: ChangeSet = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.updates.len(), 1);
        assert_eq!(parsed.updates[0].original["name"], None);
        assert_eq!(parsed.deletes[0].pk["id"], "2");
        assert!(matches!(parsed.inserts[0].values["name"], InsertValue::Value { .. }));
        assert!(matches!(parsed.inserts[0].values["age"], InsertValue::Null));
        assert!(matches!(parsed.inserts[0].values["id"], InsertValue::Default));
    }
}

#[cfg(test)]
mod write_tests {
    use super::*;
    use crate::models::{ConnectionProfile, SslMode};

    fn profile(read_only: bool) -> ConnectionProfile {
        let var = |name: &str| std::env::var(name).expect("faltan variables PGDESK_WRITE_TEST_*");
        let database = var("PGDESK_WRITE_TEST_DB");
        assert_eq!(database, "scratch", "las pruebas de escritura solo corren contra la base desechable");
        ConnectionProfile {
            id: "w".into(),
            name: "w".into(),
            host: var("PGDESK_WRITE_TEST_HOST"),
            port: var("PGDESK_WRITE_TEST_PORT").parse().unwrap(),
            database,
            user: var("PGDESK_WRITE_TEST_USER"),
            password: var("PGDESK_WRITE_TEST_PASSWORD"),
            ssl_mode: SslMode::Disable,
            read_only,
            production: false,
        }
    }

    async fn run(session: &Session, sql: &str) -> Vec<Vec<Vec<Option<String>>>> {
        db::run_sql(session, sql, 1000, 0)
            .await
            .unwrap()
            .results
            .into_iter()
            .map(|r| r.rows)
            .collect()
    }

    async fn value(session: &Session, sql: &str) -> Option<String> {
        run(session, sql).await[0][0][0].clone()
    }

    fn pk(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn set(pairs: &[(&str, Option<&str>)]) -> BTreeMap<String, Option<String>> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.map(str::to_string))).collect()
    }

    async fn fixture(session: &Session, table: &str) {
        run(
            session,
            &format!(
                "DROP TABLE IF EXISTS {table}; \
                 CREATE TABLE {table} (id serial PRIMARY KEY, name text, price numeric(10,2), ok boolean, born date, meta jsonb, tags text[]); \
                 INSERT INTO {table} (name, price, ok) VALUES ('Ana', 10.50, true), ('Luis', 2.00, false), ('Marta', NULL, NULL)"
            ),
        )
        .await;
    }

    #[tokio::test]
    #[ignore]
    async fn applies_updates_deletes_and_inserts_atomically_with_real_types() {
        let session = db::connect(&profile(false)).await.unwrap();
        let table = "pgdesk_edit_basic";
        fixture(&session, table).await;

        let changes = ChangeSet {
            updates: vec![RowUpdate {
                pk: pk(&[("id", "1")]),
                original: set(&[("name", Some("Ana")), ("price", Some("10.50")), ("ok", Some("t"))]),
                set: set(&[("name", Some("A'o \\ \"q\"")), ("price", Some("3.5")), ("ok", Some("false"))]),
            }],
            deletes: vec![RowDelete { pk: pk(&[("id", "2")]) }],
            inserts: vec![RowInsert {
                values: BTreeMap::from([
                    ("name".to_string(), InsertValue::Value { value: "New".to_string() }),
                    ("price".to_string(), InsertValue::Null),
                    ("born".to_string(), InsertValue::Value { value: "2026-01-02".to_string() }),
                    ("meta".to_string(), InsertValue::Value { value: "{\"a\": [1, 2]}".to_string() }),
                    ("tags".to_string(), InsertValue::Value { value: "{x,\"y z\"}".to_string() }),
                    ("id".to_string(), InsertValue::Default),
                ]),
            }],
        };
        let result = apply_changes(&session, "public", table, &changes).await.unwrap();
        assert_eq!((result.updated, result.deleted, result.inserted), (1, 1, 1));

        assert_eq!(value(&session, &format!("SELECT name FROM {table} WHERE id = 1")).await.as_deref(), Some("A'o \\ \"q\""));
        assert_eq!(value(&session, &format!("SELECT price::text FROM {table} WHERE id = 1")).await.as_deref(), Some("3.50"));
        assert_eq!(value(&session, &format!("SELECT ok::text FROM {table} WHERE id = 1")).await.as_deref(), Some("false"));
        assert_eq!(value(&session, &format!("SELECT count(*)::text FROM {table} WHERE id = 2")).await.as_deref(), Some("0"));
        assert_eq!(value(&session, &format!("SELECT born::text FROM {table} WHERE name = 'New'")).await.as_deref(), Some("2026-01-02"));
        assert_eq!(value(&session, &format!("SELECT meta->'a'->>1 FROM {table} WHERE name = 'New'")).await.as_deref(), Some("2"));
        assert_eq!(value(&session, &format!("SELECT tags[2] FROM {table} WHERE name = 'New'")).await.as_deref(), Some("y z"));
        assert_eq!(value(&session, &format!("SELECT (price IS NULL)::text FROM {table} WHERE name = 'New'")).await.as_deref(), Some("true"));

        run(&session, &format!("DROP TABLE {table}")).await;
    }

    #[tokio::test]
    #[ignore]
    async fn any_failure_rolls_back_every_change() {
        let session = db::connect(&profile(false)).await.unwrap();
        let table = "pgdesk_edit_atomic";
        fixture(&session, table).await;

        let valid_update = RowUpdate {
            pk: pk(&[("id", "1")]),
            original: set(&[("name", Some("Ana"))]),
            set: set(&[("name", Some("CHANGED"))]),
        };

        let stale = ChangeSet {
            updates: vec![
                valid_update.clone(),
                RowUpdate {
                    pk: pk(&[("id", "2")]),
                    original: set(&[("name", Some("alguien-lo-cambio"))]),
                    set: set(&[("name", Some("X"))]),
                },
            ],
            ..ChangeSet::default()
        };
        let error = apply_changes(&session, "public", table, &stale).await.unwrap_err();
        assert!(error.contains("Cambio 2 de 2"), "{error}");
        assert!(error.contains("otra persona"), "{error}");
        assert_eq!(value(&session, &format!("SELECT name FROM {table} WHERE id = 1")).await.as_deref(), Some("Ana"));

        let missing_delete = ChangeSet {
            updates: vec![valid_update.clone()],
            deletes: vec![RowDelete { pk: pk(&[("id", "999")]) }],
            ..ChangeSet::default()
        };
        let error = apply_changes(&session, "public", table, &missing_delete).await.unwrap_err();
        assert!(error.contains("ya no existe"), "{error}");
        assert_eq!(value(&session, &format!("SELECT name FROM {table} WHERE id = 1")).await.as_deref(), Some("Ana"));

        let duplicate_key = ChangeSet {
            updates: vec![valid_update],
            inserts: vec![RowInsert {
                values: BTreeMap::from([("id".to_string(), InsertValue::Value { value: "1".to_string() })]),
            }],
            ..ChangeSet::default()
        };
        let error = apply_changes(&session, "public", table, &duplicate_key).await.unwrap_err();
        assert!(error.contains("No se aplicó ningún cambio"), "{error}");
        assert_eq!(value(&session, &format!("SELECT name FROM {table} WHERE id = 1")).await.as_deref(), Some("Ana"));
        assert_eq!(value(&session, &format!("SELECT count(*)::text FROM {table}")).await.as_deref(), Some("3"));

        assert_eq!(value(&session, "SELECT 1::text").await.as_deref(), Some("1"));
        run(&session, &format!("DROP TABLE {table}")).await;
    }

    #[tokio::test]
    #[ignore]
    async fn composite_keys_and_refusals() {
        let session = db::connect(&profile(false)).await.unwrap();
        run(
            &session,
            "DROP TABLE IF EXISTS pgdesk_edit_pairs; DROP TABLE IF EXISTS pgdesk_edit_nopk; DROP VIEW IF EXISTS pgdesk_edit_view; \
             CREATE TABLE pgdesk_edit_pairs (a int, b text, note text, PRIMARY KEY (a, b)); \
             INSERT INTO pgdesk_edit_pairs VALUES (1,'x','one'), (1,'y','two'); \
             CREATE TABLE pgdesk_edit_nopk (x int); INSERT INTO pgdesk_edit_nopk VALUES (1),(1); \
             CREATE VIEW pgdesk_edit_view AS SELECT * FROM pgdesk_edit_pairs",
        )
        .await;

        let update = ChangeSet {
            updates: vec![RowUpdate {
                pk: pk(&[("a", "1"), ("b", "y")]),
                original: set(&[("note", Some("two"))]),
                set: set(&[("note", Some("TWO"))]),
            }],
            deletes: vec![RowDelete { pk: pk(&[("a", "1"), ("b", "x")]) }],
            ..ChangeSet::default()
        };
        let result = apply_changes(&session, "public", "pgdesk_edit_pairs", &update).await.unwrap();
        assert_eq!((result.updated, result.deleted), (1, 1));
        assert_eq!(value(&session, "SELECT string_agg(a || b || note, ',') FROM pgdesk_edit_pairs").await.as_deref(), Some("1yTWO"));

        let no_pk = ChangeSet {
            deletes: vec![RowDelete { pk: BTreeMap::new() }],
            ..ChangeSet::default()
        };
        let error = apply_changes(&session, "public", "pgdesk_edit_nopk", &no_pk).await.unwrap_err();
        assert!(error.contains("clave primaria"), "{error}");
        assert_eq!(value(&session, "SELECT count(*)::text FROM pgdesk_edit_nopk").await.as_deref(), Some("2"));

        let on_view = ChangeSet {
            deletes: vec![RowDelete { pk: pk(&[("a", "1"), ("b", "y")]) }],
            ..ChangeSet::default()
        };
        let error = apply_changes(&session, "public", "pgdesk_edit_view", &on_view).await.unwrap_err();
        assert!(error.contains("Solo se pueden editar tablas"), "{error}");

        let on_system = apply_changes(&session, "pg_catalog", "pg_class", &on_view).await.unwrap_err();
        assert!(on_system.contains("sistema"), "{on_system}");

        run(&session, "DROP VIEW pgdesk_edit_view; DROP TABLE pgdesk_edit_pairs; DROP TABLE pgdesk_edit_nopk").await;
    }

    #[tokio::test]
    #[ignore]
    async fn read_only_sessions_refuse_to_apply() {
        let writer = db::connect(&profile(false)).await.unwrap();
        fixture(&writer, "pgdesk_edit_ro").await;

        let reader = db::connect(&profile(true)).await.unwrap();
        let changes = ChangeSet {
            deletes: vec![RowDelete { pk: pk(&[("id", "1")]) }],
            ..ChangeSet::default()
        };
        let error = apply_changes(&reader, "public", "pgdesk_edit_ro", &changes).await.unwrap_err();
        assert!(error.contains("solo lectura"), "{error}");
        assert_eq!(value(&writer, "SELECT count(*)::text FROM pgdesk_edit_ro").await.as_deref(), Some("3"));

        run(&writer, "DROP TABLE pgdesk_edit_ro").await;
    }

    #[tokio::test]
    #[ignore]
    async fn dry_run_shows_the_effect_and_always_rolls_back() {
        let session = db::connect(&profile(false)).await.unwrap();
        let table = "pgdesk_edit_dry";
        fixture(&session, table).await;

        let out = db::run_sql_dry(&session, &format!("DELETE FROM {table} WHERE id <= 2 RETURNING id"), 100, 0)
            .await
            .unwrap();
        assert_eq!(out.results[0].rows.len(), 2);
        assert_eq!(value(&session, &format!("SELECT count(*)::text FROM {table}")).await.as_deref(), Some("3"));

        let failing = db::run_sql_dry(&session, &format!("DELETE FROM {table}; SELECT 1/0"), 100, 0).await;
        assert!(failing.is_err());
        assert_eq!(value(&session, &format!("SELECT count(*)::text FROM {table}")).await.as_deref(), Some("3"));

        let sneaky = db::run_sql_dry(&session, &format!("DELETE FROM {table}; COMMIT"), 100, 0).await.unwrap_err();
        assert!(sneaky.contains("COMMIT"), "{sneaky}");
        assert_eq!(value(&session, &format!("SELECT count(*)::text FROM {table}")).await.as_deref(), Some("3"));

        let in_tx = value(&session, "SELECT (txid_current_if_assigned() IS NULL)::text").await;
        assert_eq!(in_tx.as_deref(), Some("true"));

        run(&session, &format!("DROP TABLE {table}")).await;
    }
}
