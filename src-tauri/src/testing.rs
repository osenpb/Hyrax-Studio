//! Ayudas para las pruebas de integración que escriben en la base desechable `scratch`.
//! Se activan con las variables `PGDESK_WRITE_TEST_*` y rechazan cualquier otra base.

use crate::db::{self, Session};
use crate::models::{ConnectionProfile, SslMode};

pub fn profile(read_only: bool) -> ConnectionProfile {
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
        ca_cert_path: None,
        has_password: false,
    }
}

pub async fn run(session: &Session, sql: &str) -> Vec<Vec<Vec<Option<String>>>> {
    db::run_sql(session, sql, 10_000, 0)
        .await
        .unwrap()
        .results
        .into_iter()
        .map(|r| r.rows)
        .collect()
}

pub async fn value(session: &Session, sql: &str) -> Option<String> {
    run(session, sql).await[0][0][0].clone()
}
