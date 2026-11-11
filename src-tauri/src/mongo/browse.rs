//! Exploración de solo lectura: bases, colecciones y documentos.

use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use mongodb::bson::Document;
use mongodb::results::CollectionType;
use mongodb::Client;
use serde::Serialize;

use super::query;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub name: String,
    pub size_on_disk: Option<u64>,
    pub empty: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionInfo {
    pub name: String,
    /// `collection`, `view` o `timeseries`.
    pub kind: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FindPage {
    /// Cada documento como JSON extendido canónico.
    pub documents: Vec<String>,
    /// La página se cortó por el tope de tamaño.
    pub truncated: bool,
    pub elapsed_ms: u64,
}

pub struct FindParams {
    pub filter: Document,
    pub sort: Document,
    pub projection: Document,
    pub skip: u64,
    pub limit: i64,
    pub timeout: Duration,
}

fn err(e: mongodb::error::Error) -> String {
    format!("MongoDB: {e}")
}

/// Lista las bases a las que el usuario tiene acceso. Si el servidor no deja listarlas (un usuario con permisos
/// solo sobre una base) y la conexión indica una base por omisión, se usa esa.
pub async fn list_databases(client: &Client, default_db: &str) -> Result<Vec<DatabaseInfo>, String> {
    match client.list_databases().authorized_databases(true).await {
        Ok(specs) => {
            let mut list: Vec<DatabaseInfo> = specs
                .into_iter()
                .map(|s| DatabaseInfo { name: s.name, size_on_disk: Some(s.size_on_disk), empty: s.empty })
                .collect();
            list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            Ok(list)
        }
        Err(e) if !default_db.is_empty() => {
            let _ = e;
            Ok(vec![DatabaseInfo { name: default_db.to_string(), size_on_disk: None, empty: false }])
        }
        Err(e) => Err(format!(
            "{} Si tu usuario solo tiene permisos sobre una base, indícala en «Base de datos» de la conexión.",
            err(e)
        )),
    }
}

pub async fn list_collections(client: &Client, database: &str) -> Result<Vec<CollectionInfo>, String> {
    query::validate_database(database)?;
    let cursor = client.database(database).list_collections().await.map_err(err)?;
    let specs: Vec<_> = cursor.try_collect().await.map_err(err)?;
    let mut list: Vec<CollectionInfo> = specs
        .into_iter()
        .filter(|s| !s.name.starts_with("system."))
        .map(|s| CollectionInfo {
            name: s.name,
            kind: match s.collection_type {
                CollectionType::View => "view",
                CollectionType::Timeseries => "timeseries",
                _ => "collection",
            }
            .to_string(),
        })
        .collect();
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(list)
}

pub async fn find(client: &Client, database: &str, collection: &str, p: FindParams) -> Result<FindPage, String> {
    query::validate_database(database)?;
    query::validate_collection(collection)?;
    query::validate_sort(&p.sort)?;
    let started = Instant::now();

    let coll = client.database(database).collection::<Document>(collection);
    let mut action = coll
        .find(p.filter)
        .skip(query::clamp_skip(p.skip))
        .limit(query::clamp_limit(p.limit))
        .max_time(p.timeout);
    if !p.sort.is_empty() {
        action = action.sort(p.sort);
    }
    if !p.projection.is_empty() {
        action = action.projection(p.projection);
    }
    let mut cursor = action.await.map_err(err)?;

    let mut documents = Vec::new();
    let mut bytes = 0usize;
    let mut truncated = false;
    while let Some(doc) = cursor.try_next().await.map_err(err)? {
        let text = query::to_canonical(doc);
        bytes += text.len();
        if bytes > query::MAX_PAGE_BYTES && !documents.is_empty() {
            truncated = true;
            break;
        }
        documents.push(text);
    }
    Ok(FindPage { documents, truncated, elapsed_ms: started.elapsed().as_millis() as u64 })
}

/// Conteo exacto con el filtro (puede tardar en colecciones grandes: lleva tiempo máximo).
pub async fn count(
    client: &Client,
    database: &str,
    collection: &str,
    filter: Document,
    timeout: Duration,
) -> Result<u64, String> {
    query::validate_database(database)?;
    query::validate_collection(collection)?;
    client
        .database(database)
        .collection::<Document>(collection)
        .count_documents(filter)
        .max_time(timeout)
        .await
        .map_err(err)
}

/// Conteo estimado desde los metadatos: instantáneo, sin filtro.
pub async fn estimated_count(client: &Client, database: &str, collection: &str) -> Result<u64, String> {
    query::validate_database(database)?;
    query::validate_collection(collection)?;
    client
        .database(database)
        .collection::<Document>(collection)
        .estimated_document_count()
        .await
        .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ConnectionProfile;
    use mongodb::bson::{doc, oid::ObjectId, DateTime};

    const DB: &str = "hyrax_scratch_test";

    fn profile() -> ConnectionProfile {
        let var = |n: &str| std::env::var(n).unwrap_or_else(|_| panic!("falta {n}"));
        let mut p: ConnectionProfile = serde_json::from_str(
            r#"{"id":"m","name":"m","host":"localhost","port":27017,"database":"","user":"","engine":"mongodb"}"#,
        )
        .unwrap();
        p.host = var("HYRAX_MONGO_TEST_HOST");
        p.port = var("HYRAX_MONGO_TEST_PORT").parse().unwrap();
        p.user = std::env::var("HYRAX_MONGO_TEST_USER").unwrap_or_default();
        p.password = std::env::var("HYRAX_MONGO_TEST_PASSWORD").unwrap_or_default();
        p
    }

    fn params(filter: Document, sort: Document, projection: Document, skip: u64, limit: i64) -> FindParams {
        FindParams { filter, sort, projection, skip, limit, timeout: Duration::from_secs(10) }
    }

    /// Necesita un `mongod` DESECHABLE (`HYRAX_MONGO_TEST_HOST` y `HYRAX_MONGO_TEST_PORT`). Crea y borra la base
    /// `hyrax_scratch_test`; nunca toca otra.
    #[tokio::test]
    #[ignore = "necesita un mongod desechable"]
    async fn browses_a_real_server_read_only() {
        let client = crate::mongo::connect(&profile()).await.unwrap();
        let db = client.database(DB);
        db.drop().await.unwrap();

        let people = db.collection::<Document>("people");
        people
            .insert_many(vec![
                doc! {"_id": ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap(), "name": "Ana", "age": 30_i32,
                      "big": 5_i64, "born": DateTime::parse_rfc3339_str("1996-03-01T00:00:00Z").unwrap(),
                      "tags": ["a", "b"], "addr": {"city": "Lima"}},
                doc! {"name": "Beto", "age": 41_i32},
                doc! {"name": "Cora", "age": 25_i32},
            ])
            .await
            .unwrap();
        db.run_command(doc! {"create": "adults", "viewOn": "people", "pipeline": [{"$match": {"age": {"$gte": 30}}}]})
            .await
            .unwrap();

        // Bases y colecciones
        let dbs = list_databases(&client, "").await.unwrap();
        assert!(dbs.iter().any(|d| d.name == DB));
        let colls = list_collections(&client, DB).await.unwrap();
        let kinds: Vec<_> = colls.iter().map(|c| (c.name.as_str(), c.kind.as_str())).collect();
        assert_eq!(kinds, vec![("adults", "view"), ("people", "collection")]);

        // Filtro, orden y paginación
        let page = find(&client, DB, "people", params(doc! {"age": {"$gte": 30}}, doc! {"age": -1}, doc! {}, 0, 10))
            .await
            .unwrap();
        assert_eq!(page.documents.len(), 2);
        let first: serde_json::Value = serde_json::from_str(&page.documents[0]).unwrap();
        assert_eq!(first["name"], "Beto");
        let second: serde_json::Value = serde_json::from_str(&page.documents[1]).unwrap();
        // Los tipos BSON se conservan en el JSON extendido canónico
        assert_eq!(second["_id"]["$oid"], "507f1f77bcf86cd799439011");
        assert_eq!(second["age"]["$numberInt"], "30");
        assert_eq!(second["big"]["$numberLong"], "5");
        assert!(second["born"]["$date"].is_object() || second["born"]["$date"].is_string());
        assert_eq!(second["addr"]["city"], "Lima");

        let paged = find(&client, DB, "people", params(doc! {}, doc! {"age": 1}, doc! {}, 1, 1)).await.unwrap();
        let only: serde_json::Value = serde_json::from_str(&paged.documents[0]).unwrap();
        assert_eq!(only["name"], "Ana"); // 25, [30], 41

        // Proyección
        let projected = find(&client, DB, "people", params(doc! {"name": "Ana"}, doc! {}, doc! {"name": 1, "_id": 0}, 0, 5))
            .await
            .unwrap();
        let p: serde_json::Value = serde_json::from_str(&projected.documents[0]).unwrap();
        assert_eq!(p.as_object().unwrap().len(), 1);

        // Conteos
        let exact = count(&client, DB, "people", doc! {"age": {"$gt": 26}}, Duration::from_secs(10)).await.unwrap();
        assert_eq!(exact, 2);
        assert_eq!(estimated_count(&client, DB, "people").await.unwrap(), 3);

        // Una vista también se puede leer
        let adults = find(&client, DB, "adults", params(doc! {}, doc! {}, doc! {}, 0, 10)).await.unwrap();
        assert_eq!(adults.documents.len(), 2);

        // Errores claros
        let bad = find(&client, DB, "people", params(doc! {"$bogus": 1}, doc! {}, doc! {}, 0, 5)).await.unwrap_err();
        assert!(bad.contains("MongoDB"), "{bad}");
        assert!(find(&client, "a b", "people", params(doc! {}, doc! {}, doc! {}, 0, 5)).await.is_err());

        db.drop().await.unwrap();
    }
}
