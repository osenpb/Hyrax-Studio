use std::error::Error;
use std::pin::pin;
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use tokio_postgres::config::SslMode as PgSslMode;
use tokio_postgres::error::SqlState;
use tokio_postgres::{CancelToken, Client, Config, NoTls, SimpleQueryMessage};

use crate::models::*;

pub const COUNT_CAP: u64 = 100_000;
pub const TABLE_TIMEOUT_MS: u64 = 60_000;
pub const COUNT_TIMEOUT_MS: u64 = 300_000;

pub struct Session {
    pub client: Client,
    pub cancel: CancelToken,
    pub ssl: SslMode,
}

pub fn describe(e: &tokio_postgres::Error) -> String {
    if let Some(db) = e.as_db_error() {
        let code = db.code();
        if code == &SqlState::QUERY_CANCELED {
            return if db.message().contains("statement timeout") {
                "Tiempo de espera agotado: la consulta superó el límite configurado.".to_string()
            } else {
                "Consulta cancelada.".to_string()
            };
        }
        let mut text = format!("{}: {}", db.severity(), db.message());
        if let Some(detail) = db.detail() {
            text.push_str(&format!("\nDetalle: {detail}"));
        }
        if let Some(hint) = db.hint() {
            text.push_str(&format!("\nSugerencia: {hint}"));
        }
        if code == &SqlState::READ_ONLY_SQL_TRANSACTION {
            text.push_str(
                "\nPgDesk: esta sesión está en modo solo lectura. Desactívalo desde la barra del editor SQL para escribir.",
            );
        }
        return text;
    }
    let mut text = e.to_string();
    let mut source = e.source();
    while let Some(inner) = source {
        text.push_str(": ");
        text.push_str(&inner.to_string());
        source = inner.source();
    }
    text
}

pub(crate) fn err(e: tokio_postgres::Error) -> String {
    describe(&e)
}

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn quote_literal(value: &str) -> String {
    if value.contains('\\') {
        format!("E'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
    } else {
        format!("'{}'", value.replace('\'', "''"))
    }
}

fn like_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub fn build_where(filters: &[ColumnFilter]) -> Result<String, String> {
    let mut parts = Vec::new();
    for filter in filters {
        let column = quote_ident(&filter.column);
        let value = filter.value.as_deref().unwrap_or("");
        if value.contains('\0') {
            return Err("El filtro contiene un carácter no válido.".to_string());
        }
        let part = match filter.op {
            FilterOp::IsNull => format!("{column} IS NULL"),
            FilterOp::NotNull => format!("{column} IS NOT NULL"),
            FilterOp::Contains => format!(
                "{column}::text ILIKE {}",
                quote_literal(&format!("%{}%", like_escape(value)))
            ),
            FilterOp::StartsWith => format!(
                "{column}::text ILIKE {}",
                quote_literal(&format!("{}%", like_escape(value)))
            ),
            FilterOp::Equals => format!("{column} = {}", quote_literal(value)),
            FilterOp::NotEquals => format!("{column} <> {}", quote_literal(value)),
            FilterOp::Gt => format!("{column} > {}", quote_literal(value)),
            FilterOp::Gte => format!("{column} >= {}", quote_literal(value)),
            FilterOp::Lt => format!("{column} < {}", quote_literal(value)),
            FilterOp::Lte => format!("{column} <= {}", quote_literal(value)),
        };
        parts.push(part);
    }
    Ok(if parts.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", parts.join(" AND "))
    })
}

pub fn table_select_sql(
    schema: &str,
    table: &str,
    filters: &[ColumnFilter],
    order: &[SortKey],
    page: Option<(u32, u64)>,
) -> Result<String, String> {
    let mut sql = format!("SELECT * FROM {}.{}", quote_ident(schema), quote_ident(table));
    sql.push_str(&build_where(filters)?);
    if !order.is_empty() {
        let keys: Vec<String> = order
            .iter()
            .map(|k| format!("{} {}", quote_ident(&k.column), if k.descending { "DESC" } else { "ASC" }))
            .collect();
        sql.push_str(&format!(" ORDER BY {}", keys.join(", ")));
    }
    if let Some((limit, offset)) = page {
        sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));
    }
    Ok(sql)
}

fn tls_connector() -> Result<postgres_native_tls::MakeTlsConnector, String> {
    let connector = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(postgres_native_tls::MakeTlsConnector::new(connector))
}

pub async fn connect(profile: &ConnectionProfile) -> Result<Session, String> {
    let mut cfg = Config::new();
    cfg.host(&profile.host)
        .port(profile.port)
        .dbname(&profile.database)
        .user(&profile.user)
        .password(&profile.password)
        .connect_timeout(Duration::from_secs(10))
        .application_name("PgDesk");

    let session = match profile.ssl_mode {
        SslMode::Disable => {
            cfg.ssl_mode(PgSslMode::Disable);
            let (client, connection) = cfg.connect(NoTls).await.map_err(err)?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            Session {
                cancel: client.cancel_token(),
                client,
                ssl: SslMode::Disable,
            }
        }
        SslMode::Require => {
            cfg.ssl_mode(PgSslMode::Require);
            let (client, connection) = cfg.connect(tls_connector()?).await.map_err(err)?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            Session {
                cancel: client.cancel_token(),
                client,
                ssl: SslMode::Require,
            }
        }
    };

    if profile.read_only {
        set_read_only(&session.client, true).await?;
    }
    Ok(session)
}

pub async fn cancel(session: &Session) -> Result<(), String> {
    match session.ssl {
        SslMode::Disable => session.cancel.cancel_query(NoTls).await.map_err(err),
        SslMode::Require => session
            .cancel
            .cancel_query(tls_connector()?)
            .await
            .map_err(err),
    }
}

pub async fn set_read_only(client: &Client, enabled: bool) -> Result<(), String> {
    let value = if enabled { "on" } else { "off" };
    client
        .batch_execute(&format!("SET default_transaction_read_only = {value}"))
        .await
        .map_err(err)
}

pub(crate) async fn set_timeout(client: &Client, timeout_ms: u64) -> Result<(), String> {
    client
        .batch_execute(&format!("SET statement_timeout = {timeout_ms}"))
        .await
        .map_err(err)
}

pub async fn is_read_only(client: &Client) -> Result<bool, String> {
    let row = client
        .query_one("SHOW default_transaction_read_only", &[])
        .await
        .map_err(err)?;
    Ok(row.get::<_, String>(0) == "on")
}

pub async fn server_version(client: &Client) -> Result<String, String> {
    let row = client.query_one("SELECT version()", &[]).await.map_err(err)?;
    Ok(row.get::<_, String>(0))
}

pub async fn list_databases(client: &Client) -> Result<Vec<String>, String> {
    let rows = client
        .query(
            "SELECT datname::text FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname",
            &[],
        )
        .await
        .map_err(err)?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

pub async fn list_schemas(client: &Client) -> Result<Vec<SchemaInfo>, String> {
    let rows = client
        .query(
            "SELECT nspname::text FROM pg_namespace \
             WHERE nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%' \
             ORDER BY nspname",
            &[],
        )
        .await
        .map_err(err)?;
    let mut schemas: Vec<SchemaInfo> = rows
        .iter()
        .map(|r| {
            let name: String = r.get(0);
            let is_system = name.starts_with("pg_") || name == "information_schema";
            SchemaInfo { name, is_system }
        })
        .collect();
    schemas.sort_by(|a, b| a.is_system.cmp(&b.is_system).then_with(|| a.name.cmp(&b.name)));
    Ok(schemas)
}

pub async fn completion_schema(client: &Client) -> Result<Vec<CompletionTable>, String> {
    let rows = client
        .query(
            "SELECT n.nspname::text, c.relname::text, array_agg(a.attname::text ORDER BY a.attnum)              FROM pg_class c              JOIN pg_namespace n ON n.oid = c.relnamespace              JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped              WHERE c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition                AND n.nspname NOT IN ('pg_catalog','information_schema')                AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'              GROUP BY n.nspname, c.relname              ORDER BY 1, 2              LIMIT 3000",
            &[],
        )
        .await
        .map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| CompletionTable {
            schema: r.get(0),
            table: r.get(1),
            columns: r.get(2),
        })
        .collect())
}

pub async fn list_relations(client: &Client, schema: &str) -> Result<Vec<RelationInfo>, String> {
    let rows = client
        .query(
            "SELECT c.relname::text, c.relkind::text FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition \
             ORDER BY c.relname",
            &[&schema],
        )
        .await
        .map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| {
            let kind: String = r.get(1);
            let kind = match kind.as_str() {
                "r" | "p" => "table",
                "v" => "view",
                "m" => "matview",
                _ => "foreign",
            };
            RelationInfo {
                name: r.get(0),
                kind: kind.to_string(),
            }
        })
        .collect())
}

pub async fn list_columns(
    client: &Client,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let rows = client
        .query(
            "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, \
                    pg_get_expr(d.adbin, d.adrelid), \
                    EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid \
                            AND i.indisprimary AND a.attnum = ANY(i.indkey)) \
             FROM pg_attribute a \
             JOIN pg_class c ON c.oid = a.attrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum",
            &[&schema, &table],
        )
        .await
        .map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| ColumnInfo {
            name: r.get(0),
            data_type: r.get(1),
            nullable: r.get(2),
            default: r.get(3),
            is_primary_key: r.get(4),
        })
        .collect())
}

pub async fn run_simple(
    session: &Session,
    sql: &str,
    limit: usize,
    timeout_ms: u64,
) -> Result<Vec<ResultSet>, String> {
    set_timeout(&session.client, timeout_ms).await?;
    let stream = session.client.simple_query_raw(sql).await.map_err(err)?;
    let mut stream = pin!(stream);
    let mut results = Vec::new();
    let mut current: Option<ResultSet> = None;
    let mut capped = false;

    while let Some(message) = stream.try_next().await.map_err(err)? {
        match message {
            SimpleQueryMessage::RowDescription(columns) => {
                current = Some(ResultSet {
                    columns: columns.iter().map(|c| c.name().to_string()).collect(),
                    ..ResultSet::default()
                });
            }
            SimpleQueryMessage::Row(row) => {
                let set = current.get_or_insert_with(|| ResultSet {
                    columns: row.columns().iter().map(|c| c.name().to_string()).collect(),
                    ..ResultSet::default()
                });
                set.total_rows += 1;
                if set.rows.len() < limit {
                    set.rows
                        .push((0..row.len()).map(|i| row.get(i).map(str::to_string)).collect());
                } else {
                    set.truncated = true;
                }
                if set.total_rows >= COUNT_CAP {
                    set.truncated = true;
                    set.total_is_lower_bound = true;
                    capped = true;
                    break;
                }
            }
            SimpleQueryMessage::CommandComplete(count) => {
                let mut set = current.take().unwrap_or_default();
                if set.columns.is_empty() {
                    set.affected = Some(count);
                }
                results.push(set);
            }
            _ => {}
        }
    }

    if capped {
        if let Some(set) = current.take() {
            results.push(set);
        }
        let _ = cancel(session).await;
    }
    Ok(results)
}

pub async fn run_sql(
    session: &Session,
    sql: &str,
    limit: usize,
    timeout_ms: u64,
) -> Result<QueryOutput, String> {
    let started = Instant::now();
    let results = run_simple(session, sql, limit, timeout_ms).await?;
    Ok(QueryOutput {
        results,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

async fn estimated_rows(client: &Client, schema: &str, table: &str) -> Result<Option<i64>, String> {
    let rows = client
        .query(
            "SELECT c.reltuples::bigint, c.relkind::text FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &table],
        )
        .await
        .map_err(err)?;
    Ok(rows.first().and_then(|r| {
        let tuples: i64 = r.get(0);
        let kind: String = r.get(1);
        if tuples < 0 || !matches!(kind.as_str(), "r" | "p" | "m") {
            None
        } else {
            Some(tuples)
        }
    }))
}

pub async fn table_page(
    session: &Session,
    schema: &str,
    table: &str,
    limit: u32,
    offset: u64,
    filters: &[ColumnFilter],
    order: &[SortKey],
) -> Result<TablePage, String> {
    let sql = table_select_sql(schema, table, filters, order, Some((limit, offset)))?;

    let started = Instant::now();
    let mut sets = run_simple(session, &sql, limit as usize, TABLE_TIMEOUT_MS).await?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let result = if sets.is_empty() {
        ResultSet::default()
    } else {
        sets.remove(0)
    };
    let estimated_rows = if filters.is_empty() {
        estimated_rows(&session.client, schema, table).await?
    } else {
        None
    };
    Ok(TablePage {
        result,
        estimated_rows,
        elapsed_ms,
    })
}

pub async fn count_rows(
    session: &Session,
    schema: &str,
    table: &str,
    filters: &[ColumnFilter],
) -> Result<i64, String> {
    set_timeout(&session.client, COUNT_TIMEOUT_MS).await?;
    let sql = format!(
        "SELECT count(*) FROM {}.{}{}",
        quote_ident(schema),
        quote_ident(table),
        build_where(filters)?
    );
    let row = session.client.query_one(&sql, &[]).await.map_err(err)?;
    Ok(row.get(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn profile(read_only: bool) -> Option<ConnectionProfile> {
        Some(ConnectionProfile {
            id: "test".into(),
            name: "test".into(),
            host: std::env::var("PGDESK_TEST_HOST").ok()?,
            port: std::env::var("PGDESK_TEST_PORT").ok()?.parse().ok()?,
            database: std::env::var("PGDESK_TEST_DB").ok()?,
            user: std::env::var("PGDESK_TEST_USER").ok()?,
            password: std::env::var("PGDESK_TEST_PASSWORD").ok()?,
            ssl_mode: SslMode::Disable,
            read_only,
        })
    }

    #[test]
    fn quotes_identifiers_with_embedded_quotes() {
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(quote_ident("plain"), "\"plain\"");
    }

    #[tokio::test]
    #[ignore]
    async fn navigates_a_real_server() {
        let profile = profile(true).expect("faltan variables PGDESK_TEST_*");
        let session = connect(&profile).await.expect("conexion");
        let client = &session.client;
        println!("{}", server_version(client).await.unwrap());

        let databases = list_databases(client).await.unwrap();
        assert!(databases.contains(&profile.database));
        assert!(!databases.iter().any(|d| d.starts_with("template")));

        let schemas = list_schemas(client).await.unwrap();
        assert!(schemas.iter().any(|s| s.name == "public"));

        let completion = completion_schema(client).await.unwrap();
        assert!(!completion.is_empty());
        assert!(completion.iter().all(|t| !t.columns.is_empty()));
        assert!(completion.iter().all(|t| t.schema != "pg_catalog"));

        let relations = list_relations(client, "public").await.unwrap();
        let table = relations
            .iter()
            .find(|r| r.kind == "table")
            .expect("public sin tablas");

        let columns = list_columns(client, "public", &table.name).await.unwrap();
        assert!(!columns.is_empty());

        let page = table_page(
            &session,
            "public",
            &table.name,
            5,
            0,
            &[],
            &[SortKey { column: columns[0].name.clone(), descending: true }],
        )
            .await
            .unwrap();
        assert_eq!(page.result.columns.len(), columns.len());
        assert!(page.result.rows.len() <= 5);

        let count = count_rows(&session, "public", &table.name, &[]).await.unwrap();
        println!("count: {count}");

        let out = run_sql(&session, "SELECT 1 AS a, NULL::text AS b; SELECT 2 WHERE false", 100, 0)
            .await
            .unwrap();
        assert_eq!(out.results.len(), 2);
        assert_eq!(out.results[0].rows[0][0].as_deref(), Some("1"));
        assert_eq!(out.results[0].rows[0][1], None);
        assert_eq!(out.results[1].columns.len(), 1);
        assert!(out.results[1].rows.is_empty());

        let bad = run_sql(&session, "SELEC 1", 100, 0).await.unwrap_err();
        assert!(bad.contains("syntax"));
    }

    #[tokio::test]
    #[ignore]
    async fn read_only_mode_is_enforced_and_togglable() {
        let session = connect(&profile(true).unwrap()).await.unwrap();
        assert!(is_read_only(&session.client).await.unwrap());

        let blocked = run_sql(&session, "CREATE TEMP TABLE pgdesk_probe (a int)", 10, 0)
            .await
            .unwrap_err();
        println!("{blocked}");
        assert!(blocked.contains("solo lectura"));

        set_read_only(&session.client, false).await.unwrap();
        assert!(!is_read_only(&session.client).await.unwrap());
        set_read_only(&session.client, true).await.unwrap();
        assert!(is_read_only(&session.client).await.unwrap());

        let writable = connect(&profile(false).unwrap()).await.unwrap();
        assert!(!is_read_only(&writable.client).await.unwrap());
    }

    #[tokio::test]
    #[ignore]
    async fn statement_timeout_aborts_long_queries() {
        let session = connect(&profile(true).unwrap()).await.unwrap();
        let started = Instant::now();
        let error = run_sql(&session, "SELECT pg_sleep(30)", 10, 400).await.unwrap_err();
        println!("{error}");
        assert!(error.contains("Tiempo de espera"));
        assert!(started.elapsed() < Duration::from_secs(5));

        let ok = run_sql(&session, "SELECT 1", 10, 0).await.unwrap();
        assert_eq!(ok.results[0].rows[0][0].as_deref(), Some("1"));
    }

    #[tokio::test]
    #[ignore]
    async fn running_query_can_be_cancelled() {
        let session = Arc::new(connect(&profile(true).unwrap()).await.unwrap());
        let runner = session.clone();
        let handle = tokio::spawn(async move { run_sql(&runner, "SELECT pg_sleep(30)", 10, 0).await });

        tokio::time::sleep(Duration::from_millis(400)).await;
        let started = Instant::now();
        cancel(&session).await.unwrap();
        let result = handle.await.unwrap();

        assert_eq!(result.unwrap_err(), "Consulta cancelada.");
        assert!(started.elapsed() < Duration::from_secs(5));

        let ok = run_sql(&session, "SELECT 1", 10, 0).await.unwrap();
        assert_eq!(ok.results[0].rows[0][0].as_deref(), Some("1"));
    }

    #[tokio::test]
    #[ignore]
    async fn huge_results_are_capped_without_loading_everything() {
        let session = connect(&profile(true).unwrap()).await.unwrap();
        let out = run_sql(&session, "SELECT g FROM generate_series(1, 2000000) g", 1000, 0)
            .await
            .unwrap();
        let set = &out.results[0];
        assert_eq!(set.rows.len(), 1000);
        assert!(set.truncated);
        assert!(set.total_is_lower_bound);
        assert_eq!(set.total_rows, COUNT_CAP);

        let ok = run_sql(&session, "SELECT 7", 10, 0).await.unwrap();
        assert_eq!(ok.results[0].rows[0][0].as_deref(), Some("7"));
    }

    #[tokio::test]
    #[ignore]
    async fn explain_returns_a_plan_column_with_one_line_per_row() {
        let session = connect(&profile(true).unwrap()).await.unwrap();
        let plain = run_sql(&session, "EXPLAIN SELECT 1", 100, 0).await.unwrap();
        assert_eq!(plain.results[0].columns, vec!["QUERY PLAN".to_string()]);
        assert!(!plain.results[0].rows.is_empty());

        let analyzed = run_sql(&session, "EXPLAIN (ANALYZE, BUFFERS) SELECT 1", 100, 0)
            .await
            .unwrap();
        let text: Vec<String> = analyzed.results[0]
            .rows
            .iter()
            .filter_map(|r| r[0].clone())
            .collect();
        assert!(text.iter().any(|l| l.contains("Execution Time")));
    }

    fn filter(column: &str, op: FilterOp, value: Option<&str>) -> ColumnFilter {
        ColumnFilter {
            column: column.to_string(),
            op,
            value: value.map(str::to_string),
        }
    }

    #[test]
    fn where_clause_escapes_values_and_identifiers() {
        assert_eq!(build_where(&[]).unwrap(), "");
        let sql = build_where(&[
            filter("na\"me", FilterOp::Contains, Some("50%_off")),
            filter("age", FilterOp::Gte, Some("18")),
            filter("note", FilterOp::IsNull, None),
        ])
        .unwrap();
        assert_eq!(
            sql,
            " WHERE \"na\"\"me\"::text ILIKE E'%50\\\\%\\\\_off%' AND \"age\" >= '18' AND \"note\" IS NULL"
        );
        let quoted = build_where(&[filter("a", FilterOp::Equals, Some("it's"))]).unwrap();
        assert_eq!(quoted, " WHERE \"a\" = 'it''s'");
        assert!(build_where(&[filter("a", FilterOp::Equals, Some("x\0y"))]).is_err());
    }

    #[test]
    fn select_sql_orders_by_several_columns_in_priority_order() {
        let order = [
            SortKey { column: "last".into(), descending: false },
            SortKey { column: "a\"ge".into(), descending: true },
        ];
        let sql = table_select_sql("public", "people", &[], &order, Some((50, 100))).unwrap();
        assert_eq!(
            sql,
            "SELECT * FROM \"public\".\"people\" ORDER BY \"last\" ASC, \"a\"\"ge\" DESC LIMIT 50 OFFSET 100"
        );
        let plain = table_select_sql("public", "people", &[], &[], None).unwrap();
        assert_eq!(plain, "SELECT * FROM \"public\".\"people\"");
    }

    #[tokio::test]
    #[ignore]
    async fn filters_narrow_the_page_and_resist_injection() {
        let session = connect(&profile(true).unwrap()).await.unwrap();
        let relations = list_relations(&session.client, "public").await.unwrap();
        let table = relations.iter().find(|r| r.kind == "table").unwrap();
        let columns = list_columns(&session.client, "public", &table.name).await.unwrap();
        let first = &columns[0].name;

        let all = table_page(&session, "public", &table.name, 50, 0, &[], &[])
            .await
            .unwrap();
        assert!(all.estimated_rows.is_some() || all.result.rows.len() <= 50);
        let sample = all.result.rows[0][0].clone().unwrap();

        let exact = table_page(
            &session,
            "public",
            &table.name,
            50,
            0,
            &[filter(first, FilterOp::Equals, Some(&sample))],
            &[],
        )
        .await
        .unwrap();
        assert!(!exact.result.rows.is_empty());
        assert!(exact.result.rows.iter().all(|r| r[0].as_deref() == Some(sample.as_str())));
        assert!(exact.estimated_rows.is_none());

        let none = table_page(
            &session,
            "public",
            &table.name,
            50,
            0,
            &[filter(first, FilterOp::Contains, Some("__no_existe__"))],
            &[],
        )
        .await
        .unwrap();
        assert!(none.result.rows.is_empty());

        let hostile = table_page(
            &session,
            "public",
            &table.name,
            50,
            0,
            &[filter(first, FilterOp::Contains, Some("'; DROP TABLE x; --"))],
            &[],
        )
        .await
        .unwrap();
        assert!(hostile.result.rows.is_empty());

        let filtered_count = count_rows(
            &session,
            "public",
            &table.name,
            &[filter(first, FilterOp::Equals, Some(&sample))],
        )
        .await
        .unwrap();
        assert_eq!(filtered_count as usize, exact.result.rows.len());
    }

    #[tokio::test]
    #[ignore]
    async fn exports_csv_json_and_sql_with_types() {
        use crate::export::export_query;

        let session = connect(&profile(true).unwrap()).await.unwrap();
        let sql = "SELECT 1 AS id, 'x,\"y' AS note, NULL::text AS gap, true AS ok, 2.50::numeric AS price, '{\"k\": [1, 2]}'::jsonb AS doc \
                   UNION ALL SELECT 2, 'it''s', 'z', false, 0.1, NULL";
        let dir = std::env::temp_dir().join(format!("pgdesk-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let csv_path = dir.join("out.csv");
        let n = export_query(&session, sql, ExportFormat::Csv, csv_path.to_str().unwrap(), "\"t\"")
            .await
            .unwrap();
        assert_eq!(n, 2);
        let csv = std::fs::read_to_string(&csv_path).unwrap();
        assert!(csv.starts_with('\u{feff}'));
        let lines: Vec<&str> = csv.trim_start_matches('\u{feff}').split("\r\n").collect();
        assert_eq!(lines[0], "id,note,gap,ok,price,doc");
        assert_eq!(lines[1], "1,\"x,\"\"y\",,t,2.50,\"{\"\"k\"\": [1, 2]}\"");

        let json_path = dir.join("out.json");
        export_query(&session, sql, ExportFormat::Json, json_path.to_str().unwrap(), "\"t\"")
            .await
            .unwrap();
        let raw_json = std::fs::read_to_string(&json_path).unwrap();
        assert!(raw_json.contains("\"price\":2.50"));
        let parsed: serde_json::Value = serde_json::from_str(&raw_json).unwrap();
        assert_eq!(parsed[0]["id"], 1);
        assert_eq!(parsed[0]["note"], "x,\"y");
        assert!(parsed[0]["gap"].is_null());
        assert_eq!(parsed[0]["ok"], true);
        assert_eq!(parsed[0]["price"], 2.5);
        assert_eq!(parsed[0]["doc"]["k"][1], 2);
        assert_eq!(parsed[1]["ok"], false);
        assert_eq!(parsed[1]["note"], "it's");

        let sql_path = dir.join("out.sql");
        export_query(&session, sql, ExportFormat::Sql, sql_path.to_str().unwrap(), "\"public\".\"t\"")
            .await
            .unwrap();
        let inserts = std::fs::read_to_string(&sql_path).unwrap();
        assert!(inserts.contains(
            "INSERT INTO \"public\".\"t\" (\"id\", \"note\", \"gap\", \"ok\", \"price\", \"doc\") VALUES (1, 'x,\"y', NULL, TRUE, 2.50, '{\"k\": [1, 2]}');"
        ));
        assert!(inserts.contains("(2, 'it''s', 'z', FALSE, 0.1, NULL);"));

        let empty_path = dir.join("empty.json");
        let zero = export_query(&session, "SELECT 1 AS a WHERE false", ExportFormat::Json, empty_path.to_str().unwrap(), "\"t\"")
            .await
            .unwrap();
        assert_eq!(zero, 0);
        assert_eq!(std::fs::read_to_string(&empty_path).unwrap().trim(), "[]");

        let bad_path = dir.join("bad.csv");
        let failed = export_query(&session, "SELEC 1", ExportFormat::Csv, bad_path.to_str().unwrap(), "\"t\"").await;
        assert!(failed.is_err());
        assert!(!bad_path.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
