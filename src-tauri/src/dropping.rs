use tokio_postgres::error::SqlState;

use crate::db::{self, quote_ident, Session};
use crate::models::ConnectionProfile;

/// El nombre del objeto o de la base debe repetirse tal cual: lo exige el backend aunque la interfaz ya lo pida.
pub fn check_confirm(expected: &str, confirm: &str) -> Result<(), String> {
    if expected.is_empty() || confirm != expected {
        return Err(format!(
            "Para eliminarlo hay que escribir su nombre exacto ({expected})."
        ));
    }
    Ok(())
}

fn is_system_schema(schema: &str) -> bool {
    schema.starts_with("pg_") || schema == "information_schema"
}

pub fn drop_object_sql(schema: &str, name: &str, kind: &str, cascade: bool) -> Result<String, String> {
    if schema.is_empty() || name.is_empty() {
        return Err("Falta el nombre del objeto.".to_string());
    }
    if is_system_schema(schema) {
        return Err("Los objetos del sistema no se pueden eliminar.".to_string());
    }
    let keyword = match kind {
        "table" => "TABLE",
        "view" => "VIEW",
        "matview" => "MATERIALIZED VIEW",
        "foreign" => "FOREIGN TABLE",
        _ => return Err("Tipo de objeto no válido.".to_string()),
    };
    Ok(format!(
        "DROP {keyword} {}.{}{}",
        quote_ident(schema),
        quote_ident(name),
        if cascade { " CASCADE" } else { "" }
    ))
}

pub fn drop_database_sql(database: &str, force: bool) -> Result<String, String> {
    if database.is_empty() {
        return Err("Falta el nombre de la base de datos.".to_string());
    }
    if database == "template0" || database == "template1" {
        return Err("Las bases plantilla no se pueden eliminar.".to_string());
    }
    Ok(format!(
        "DROP DATABASE {}{}",
        quote_ident(database),
        if force { " WITH (FORCE)" } else { "" }
    ))
}

/// Base a la que conectarse para poder eliminar `database` (no se puede eliminar la base a la que se está conectado).
pub fn maintenance_database(database: &str) -> &'static str {
    if database == "postgres" {
        "template1"
    } else {
        "postgres"
    }
}

async fn rollback(session: &Session) {
    if session.client.batch_execute("ROLLBACK").await.is_err() {
        let _ = session.client.batch_execute("ROLLBACK").await;
    }
}

pub async fn drop_object(
    session: &Session,
    schema: &str,
    name: &str,
    kind: &str,
    cascade: bool,
    confirm: &str,
) -> Result<String, String> {
    check_confirm(name, confirm)?;
    let sql = drop_object_sql(schema, name, kind, cascade)?;
    if db::is_read_only(&session.client).await? {
        return Err("La sesión está en modo solo lectura. Habilita la escritura para eliminar.".to_string());
    }
    session.client.batch_execute("BEGIN").await.map_err(db::err)?;
    if let Err(e) = session.client.batch_execute("SET LOCAL lock_timeout = '5s'").await {
        rollback(session).await;
        return Err(db::err(e));
    }
    if let Err(e) = session.client.batch_execute(&sql).await {
        rollback(session).await;
        let mut text = db::describe(&e);
        if e.as_db_error().is_some_and(|d| d.code() == &SqlState::LOCK_NOT_AVAILABLE) {
            text.push_str("\nPgDesk: otra sesión tiene bloqueado el objeto; inténtalo de nuevo cuando termine.");
        }
        return Err(text);
    }
    session
        .client
        .batch_execute("COMMIT")
        .await
        .map_err(|e| format!("No se pudo confirmar la transacción: {}", db::describe(&e)))?;
    Ok(sql)
}

/// Elimina una base de datos desde una sesión de mantenimiento propia (nunca desde la base que se elimina).
pub async fn drop_database(profile: &ConnectionProfile, database: &str, force: bool, confirm: &str) -> Result<String, String> {
    check_confirm(database, confirm)?;
    let sql = drop_database_sql(database, force)?;
    let mut maintenance = profile.clone();
    maintenance.database = maintenance_database(database).to_string();
    maintenance.read_only = false;
    maintenance.production = false;
    let session = db::connect(&maintenance).await?;
    if let Err(e) = session.client.batch_execute("SET statement_timeout = 30000").await {
        return Err(db::describe(&e));
    }
    if let Err(e) = session.client.batch_execute(&sql).await {
        let mut text = db::describe(&e);
        if e.as_db_error().is_some_and(|d| d.code() == &SqlState::OBJECT_IN_USE) {
            text.push_str(
                "\nPgDesk: hay otras conexiones abiertas a esa base (de otras aplicaciones o personas). Ciérralas o marca «Forzar» para desconectarlas.",
            );
        }
        return Err(text);
    }
    Ok(sql)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confirmation_must_match_exactly() {
        assert!(check_confirm("orders", "orders").is_ok());
        assert!(check_confirm("orders", "Orders").is_err());
        assert!(check_confirm("orders", "orders ").is_err());
        assert!(check_confirm("orders", "").is_err());
        assert!(check_confirm("", "").is_err());
        assert!(check_confirm("orders", "orders").is_ok());
    }

    #[test]
    fn builds_quoted_drop_statements() {
        assert_eq!(
            drop_object_sql("public", "orders", "table", false).unwrap(),
            "DROP TABLE \"public\".\"orders\""
        );
        assert_eq!(
            drop_object_sql("my\"s", "a\"b", "view", true).unwrap(),
            "DROP VIEW \"my\"\"s\".\"a\"\"b\" CASCADE"
        );
        assert_eq!(
            drop_object_sql("s", "t", "matview", false).unwrap(),
            "DROP MATERIALIZED VIEW \"s\".\"t\""
        );
        assert_eq!(
            drop_object_sql("s", "t", "foreign", false).unwrap(),
            "DROP FOREIGN TABLE \"s\".\"t\""
        );
        assert_eq!(drop_database_sql("shop", false).unwrap(), "DROP DATABASE \"shop\"");
        assert_eq!(
            drop_database_sql("a\"b", true).unwrap(),
            "DROP DATABASE \"a\"\"b\" WITH (FORCE)"
        );
    }

    #[test]
    fn refuses_system_objects_unknown_kinds_and_templates() {
        assert!(drop_object_sql("pg_catalog", "pg_class", "table", false).is_err());
        assert!(drop_object_sql("information_schema", "tables", "view", false).is_err());
        assert!(drop_object_sql("public", "t", "function", false).is_err());
        assert!(drop_object_sql("public", "t; DROP TABLE x", "sequence", false).is_err());
        assert!(drop_object_sql("", "t", "table", false).is_err());
        assert!(drop_database_sql("template0", false).is_err());
        assert!(drop_database_sql("template1", true).is_err());
        assert!(drop_database_sql("", false).is_err());
    }

    #[test]
    fn an_injected_name_stays_inside_its_identifier() {
        let sql = drop_object_sql("public", "t\"; DROP TABLE users; --", "table", false).unwrap();
        assert_eq!(sql, "DROP TABLE \"public\".\"t\"\"; DROP TABLE users; --\"");
    }

    #[tokio::test]
    #[ignore]
    async fn drops_objects_safely_and_databases_from_a_maintenance_session() {
        use crate::testing::{profile, run, value};
        let session = db::connect(&profile(false)).await.unwrap();
        run(
            &session,
            "DROP SCHEMA IF EXISTS pgdesk_drop CASCADE; CREATE SCHEMA pgdesk_drop; \
             CREATE TABLE pgdesk_drop.parent (id int PRIMARY KEY); \
             CREATE TABLE pgdesk_drop.child (pid int REFERENCES pgdesk_drop.parent(id)); \
             CREATE VIEW pgdesk_drop.v AS SELECT * FROM pgdesk_drop.parent; \
             CREATE TABLE pgdesk_drop.solo (a int)",
        )
        .await;
        let exists = |name: &'static str| {
            let session = &session;
            async move {
                value(session, &format!("SELECT to_regclass('pgdesk_drop.{name}') IS NOT NULL"))
                    .await
                    .unwrap()
                    == "t"
            }
        };

        // Sin el nombre exacto no se toca nada.
        let wrong = drop_object(&session, "pgdesk_drop", "solo", "table", false, "otro").await.unwrap_err();
        assert!(wrong.contains("nombre exacto"), "{wrong}");
        assert!(exists("solo").await);

        // Una sesión de solo lectura se niega.
        let read_only = db::connect(&profile(true)).await.unwrap();
        let refused = drop_object(&read_only, "pgdesk_drop", "solo", "table", false, "solo").await.unwrap_err();
        assert!(refused.contains("solo lectura"), "{refused}");
        assert!(exists("solo").await);

        // Sin CASCADE, si algo depende, falla y no se borra nada.
        let blocked = drop_object(&session, "pgdesk_drop", "parent", "table", false, "parent").await.unwrap_err();
        assert!(blocked.to_lowercase().contains("depend"), "{blocked}");
        assert!(exists("parent").await && exists("child").await && exists("v").await);

        // El tipo debe coincidir con el objeto.
        let kind = drop_object(&session, "pgdesk_drop", "child", "view", false, "child").await.unwrap_err();
        assert!(kind.to_lowercase().contains("view"), "{kind}");
        assert!(exists("child").await);

        // Con CASCADE se borra la tabla y lo que dependía (la vista y la clave foránea), no la tabla hija.
        let sql = drop_object(&session, "pgdesk_drop", "parent", "table", true, "parent").await.unwrap();
        assert_eq!(sql, "DROP TABLE \"pgdesk_drop\".\"parent\" CASCADE");
        assert!(!exists("parent").await && !exists("v").await && exists("child").await);
        assert_eq!(
            value(&session, "SELECT count(*) FROM pg_constraint WHERE conrelid = 'pgdesk_drop.child'::regclass AND contype = 'f'")
                .await
                .as_deref(),
            Some("0")
        );

        assert!(drop_object(&session, "pgdesk_drop", "solo", "table", false, "solo").await.is_ok());
        assert!(!exists("solo").await);
        assert!(drop_object(&session, "pg_catalog", "pg_class", "table", false, "pg_class").await.is_err());
        // Una transacción abortada por un error no deja la sesión rota.
        assert_eq!(value(&session, "SELECT 1").await.as_deref(), Some("1"));
        run(&session, "DROP SCHEMA pgdesk_drop CASCADE").await;

        // Bases de datos: se eliminan desde la base de mantenimiento.
        run(&session, "DROP DATABASE IF EXISTS pgdesk_drop_me").await;
        run(&session, "CREATE DATABASE pgdesk_drop_me").await;
        let mut other = profile(false);
        other.database = "pgdesk_drop_me".to_string();
        let held = db::connect(&other).await.unwrap();
        assert_eq!(value(&held, "SELECT current_database()").await.as_deref(), Some("pgdesk_drop_me"));

        let wrong = drop_database(&profile(false), "pgdesk_drop_me", false, "pgdesk_drop").await.unwrap_err();
        assert!(wrong.contains("nombre exacto"), "{wrong}");
        let in_use = drop_database(&profile(false), "pgdesk_drop_me", false, "pgdesk_drop_me").await.unwrap_err();
        assert!(in_use.contains("otras conexiones"), "{in_use}");
        async fn present(session: &Session) -> String {
            crate::testing::value(session, "SELECT count(*) FROM pg_database WHERE datname = 'pgdesk_drop_me'")
                .await
                .unwrap()
        }
        assert_eq!(present(&session).await, "1");

        let sql = drop_database(&profile(false), "pgdesk_drop_me", true, "pgdesk_drop_me").await.unwrap();
        assert_eq!(sql, "DROP DATABASE \"pgdesk_drop_me\" WITH (FORCE)");
        assert_eq!(present(&session).await, "0");
        drop(held);
        assert!(drop_database(&profile(false), "template1", true, "template1").await.is_err());
    }

    #[test]
    fn never_connects_to_the_database_being_dropped() {
        assert_eq!(maintenance_database("shop"), "postgres");
        assert_eq!(maintenance_database("postgres"), "template1");
    }
}
