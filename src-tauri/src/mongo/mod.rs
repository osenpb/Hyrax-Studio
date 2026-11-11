//! Soporte para MongoDB (fase M0: probar la conexión). Ver `docs/MONGODB.md`.

pub mod browse;
pub mod query;
pub mod uri;

use std::path::PathBuf;
use std::time::Duration;

use mongodb::bson::doc;
use mongodb::options::{ClientOptions, Credential, Tls, TlsOptions};
use mongodb::Client;

use crate::models::{ConnectionProfile, Engine, SslMode};

const TIMEOUT: Duration = Duration::from_secs(10);

/// Sesión de MongoDB abierta: una por conexión guardada (el driver ya agrupa las conexiones de red).
pub struct MongoSession {
    pub client: Client,
    pub production: bool,
    /// Base indicada en la conexión (para usuarios que no pueden listar todas).
    pub default_db: String,
}

/// Crea el cliente a partir del perfil. La contraseña va en las opciones, nunca en la URI.
pub async fn connect(profile: &ConnectionProfile) -> Result<Client, String> {
    if profile.engine != Engine::Mongodb {
        return Err("La conexión no es de MongoDB.".to_string());
    }
    if profile.ssh.enabled {
        return Err("El túnel SSH para MongoDB todavía no está disponible.".to_string());
    }
    let uri = uri::build_uri(profile)?;
    let mut options = ClientOptions::parse(uri)
        .await
        .map_err(|e| format!("La dirección de MongoDB no es válida: {e}"))?;

    options.app_name = Some("Hyrax Studio".to_string());
    options.connect_timeout = Some(TIMEOUT);
    options.server_selection_timeout = Some(TIMEOUT);

    if !profile.user.trim().is_empty() {
        let source = profile
            .mongo
            .auth_source
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("admin")
            .to_string();
        options.credential = Some(
            Credential::builder()
                .username(profile.user.trim().to_string())
                .password(profile.password.clone())
                .source(source)
                .build(),
        );
    }

    options.tls = match profile.ssl_mode {
        SslMode::Disable => Some(Tls::Disabled),
        SslMode::Require => Some(Tls::Enabled(TlsOptions::builder().allow_invalid_certificates(true).build())),
        SslMode::Verify => {
            let ca = profile
                .ca_cert_path
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(PathBuf::from);
            if let Some(path) = &ca {
                if !path.is_file() {
                    return Err(format!("No se pudo leer el certificado de la CA ({}).", path.display()));
                }
            }
            Some(Tls::Enabled(TlsOptions::builder().ca_file_path(ca).build()))
        }
    };

    Client::with_options(options).map_err(|e| format!("No se pudo crear el cliente de MongoDB: {e}"))
}

/// Pregunta la versión del servidor (`buildInfo` no escribe nada).
pub async fn version(client: &Client) -> Result<String, String> {
    let info = client
        .database("admin")
        .run_command(doc! { "buildInfo": 1 })
        .await
        .map_err(|e| format!("No se pudo conectar con MongoDB: {e}"))?;
    Ok(format!("MongoDB {}", info.get_str("version").unwrap_or("desconocida")))
}

/// Conecta, comprueba que el servidor responde y devuelve su versión.
pub async fn test(profile: &ConnectionProfile) -> Result<String, String> {
    version(&connect(profile).await?).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(ssl: SslMode, ca: Option<&str>) -> ConnectionProfile {
        let mut p: ConnectionProfile = serde_json::from_str(
            r#"{"id":"m","name":"m","host":"localhost","port":27017,"database":"","user":"","engine":"mongodb"}"#,
        )
        .unwrap();
        p.ssl_mode = ssl;
        p.ca_cert_path = ca.map(String::from);
        p
    }

    #[tokio::test]
    async fn refuses_non_mongo_profiles_and_ssh_tunnels() {
        let mut p = profile(SslMode::Disable, None);
        p.engine = Engine::Postgres;
        assert!(connect(&p).await.is_err());

        let mut p = profile(SslMode::Disable, None);
        p.ssh.enabled = true;
        assert!(connect(&p).await.unwrap_err().contains("túnel SSH"));
    }

    #[tokio::test]
    async fn a_missing_ca_file_is_reported_before_connecting() {
        let p = profile(SslMode::Verify, Some("C:/no/existe/ca.pem"));
        assert!(connect(&p).await.unwrap_err().contains("certificado de la CA"));
    }

    /// Necesita un `mongod` desechable: `HYRAX_MONGO_TEST_HOST` y `HYRAX_MONGO_TEST_PORT`
    /// (y, si exige autenticación, `HYRAX_MONGO_TEST_USER` y `HYRAX_MONGO_TEST_PASSWORD`).
    /// Solo ejecuta `buildInfo`, que no escribe nada.
    #[tokio::test]
    #[ignore = "necesita un mongod desechable"]
    async fn tests_a_real_server_and_reports_its_version() {
        let var = |n: &str| std::env::var(n).unwrap_or_else(|_| panic!("falta {n}"));
        let mut p = profile(SslMode::Disable, None);
        p.host = var("HYRAX_MONGO_TEST_HOST");
        p.port = var("HYRAX_MONGO_TEST_PORT").parse().unwrap();
        p.user = std::env::var("HYRAX_MONGO_TEST_USER").unwrap_or_default();
        p.password = std::env::var("HYRAX_MONGO_TEST_PASSWORD").unwrap_or_default();

        let version = test(&p).await.expect("debía conectar");
        assert!(version.starts_with("MongoDB "), "{version}");

        // Un puerto sin servidor falla con un mensaje claro y sin colgarse.
        p.port = 1;
        let err = test(&p).await.expect_err("debía fallar");
        assert!(err.contains("MongoDB"), "{err}");
    }
}
