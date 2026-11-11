//! Túnel SSH (reenvío local de puertos) para llegar a un Postgres que no es accesible directamente.
//!
//! La clave del servidor SSH no se acepta a ciegas: se fija en el perfil por su huella SHA-256. La primera
//! vez la conexión falla con `HYRAX_SSH_UNKNOWN_KEY:<huella>` para que el usuario la confirme; si luego
//! cambia, falla con `HYRAX_SSH_CHANGED_KEY:<huella>`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handler};
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKey};
use tokio::net::TcpListener;
use tokio::task::{JoinHandle, JoinSet};

use crate::models::SshSettings;

pub const UNKNOWN_KEY: &str = "HYRAX_SSH_UNKNOWN_KEY";
pub const CHANGED_KEY: &str = "HYRAX_SSH_CHANGED_KEY";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const PROBE_WINDOW: Duration = Duration::from_millis(500);

/// Mientras exista, el puerto local reenvía al servidor; al soltarlo se cierra todo.
pub struct Tunnel {
    pub local_port: u16,
    task: JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct Verifier {
    expected: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
}

impl Handler for Verifier {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        *self.seen.lock().unwrap() = Some(fingerprint.clone());
        Ok(self.expected.as_deref() == Some(fingerprint.as_str()))
    }
}

/// Mensaje de error cuando el servidor rechazó nuestra comprobación de la clave.
fn host_key_error(expected: &Option<String>, seen: &Option<String>) -> Option<String> {
    let seen = seen.as_ref()?;
    match expected {
        Some(e) if e == seen => None,
        Some(_) => Some(format!("{CHANGED_KEY}:{seen}")),
        None => Some(format!("{UNKNOWN_KEY}:{seen}")),
    }
}

/// Expande un `~` inicial (como en `~/.ssh/id_ed25519`) con la carpeta personal del usuario.
fn expand_home(path: &str) -> String {
    let rest = match path.strip_prefix('~') {
        Some(r) if r.is_empty() || r.starts_with('/') || r.starts_with('\\') => r,
        _ => return path.to_string(),
    };
    match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Ok(home) => format!("{}{rest}", home.trim_end_matches(['/', '\\'])),
        Err(_) => path.to_string(),
    }
}

/// Descifrar una clave (KDF) es costoso: se hace fuera de los hilos del runtime asíncrono.
async fn load_key(path: &str, passphrase: Option<String>) -> Result<keys::PrivateKey, String> {
    let path = expand_home(path);
    let shown = path.clone();
    tokio::task::spawn_blocking(move || keys::load_secret_key(&path, passphrase.as_deref()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| match e {
            keys::Error::IO(io) => format!("No se pudo leer el archivo de la clave privada SSH ({shown}): {io}."),
            other => format!("No se pudo usar la clave privada SSH ({shown}): {other}. Si tiene frase de contraseña, indícala."),
        })
}

fn validate(ssh: &SshSettings) -> Result<(), String> {
    if ssh.host.trim().is_empty() {
        return Err("Falta el host del servidor SSH.".to_string());
    }
    if ssh.user.trim().is_empty() {
        return Err("Falta el usuario del servidor SSH.".to_string());
    }
    Ok(())
}

pub async fn open(ssh: &SshSettings, target_host: &str, target_port: u16) -> Result<Tunnel, String> {
    validate(ssh)?;
    let port = if ssh.port == 0 { 22 } else { ssh.port };
    let expected = ssh.fingerprint.clone().filter(|f| !f.trim().is_empty());
    let seen = Arc::new(Mutex::new(None));

    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });
    let verifier = Verifier { expected: expected.clone(), seen: seen.clone() };
    let connecting = client::connect(config, (ssh.host.trim(), port), verifier);
    let mut handle = match tokio::time::timeout(CONNECT_TIMEOUT, connecting).await {
        Err(_) => return Err(format!("Tiempo agotado al conectar con el servidor SSH {}:{port}.", ssh.host.trim())),
        Ok(Err(e)) => {
            let seen = seen.lock().unwrap().clone();
            return Err(host_key_error(&expected, &seen)
                .unwrap_or_else(|| format!("No se pudo conectar con el servidor SSH {}:{port}: {e}", ssh.host.trim())));
        }
        Ok(Ok(handle)) => handle,
    };

    let secret = (!ssh.secret.is_empty()).then_some(ssh.secret.clone());
    let key = match ssh.key_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(path) => Some(load_key(path, secret.clone()).await?),
        None => None,
    };
    let user = ssh.user.trim().to_string();
    let authenticating = async {
        match key {
            Some(key) => {
                let hash = handle
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| format!("Error SSH: {e}"))?
                    .flatten();
                handle
                    .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                    .await
                    .map_err(|e| format!("Error SSH al autenticar: {e}"))
            }
            None => handle
                .authenticate_password(user, secret.unwrap_or_default())
                .await
                .map_err(|e| format!("Error SSH al autenticar: {e}")),
        }
    };
    let result = tokio::time::timeout(CONNECT_TIMEOUT, authenticating)
        .await
        .map_err(|_| "Tiempo agotado al autenticar en el servidor SSH.".to_string())??;
    if !result.success() {
        return Err("El servidor SSH rechazó las credenciales.".to_string());
    }

    // Se comprueba ya que el servidor permite el reenvío hacia Postgres, para dar el motivo real
    // (reenvío deshabilitado, destino inalcanzable…) en vez de un "conexión cerrada" genérico.
    let probe = tokio::time::timeout(
        CONNECT_TIMEOUT,
        handle.channel_open_direct_tcpip(target_host, target_port as u32, "127.0.0.1", 0),
    )
    .await
    .map_err(|_| format!("Tiempo agotado al pedir al servidor SSH el reenvío hacia {target_host}:{target_port}."))?
    .map_err(|e| {
        format!("El servidor SSH no pudo reenviar hacia {target_host}:{target_port}: {e}. Revisa el host y el puerto de Postgres (vistos desde el servidor SSH) y que AllowTcpForwarding esté permitido.")
    })?;
    // Algunos servidores confirman el canal y lo cierran después si el destino no responde: Postgres no
    // habla primero, así que cualquier cierre en este instante significa que el reenvío no funciona.
    let mut probe = probe;
    if let Ok(msg) = tokio::time::timeout(PROBE_WINDOW, probe.wait()).await {
        if matches!(msg, None | Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close)) {
            return Err(format!(
                "El servidor SSH abrió el reenvío hacia {target_host}:{target_port} pero lo cerró de inmediato: el destino no responde o el reenvío está restringido. Revisa el host y el puerto de Postgres (vistos desde el servidor SSH)."
            ));
        }
    }
    let _ = probe.close().await;

    // Solo loopback: el túnel no debe quedar expuesto a la red.
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("No se pudo abrir el puerto local del túnel: {e}"))?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let handle = Arc::new(handle);
    let target_host = target_host.to_string();
    let task = tokio::spawn(async move {
        let mut forwards = JoinSet::new();
        loop {
            let Ok((mut socket, peer)) = listener.accept().await else { break };
            let handle = handle.clone();
            let target_host = target_host.clone();
            forwards.spawn(async move {
                let Ok(channel) = handle
                    .channel_open_direct_tcpip(target_host, target_port as u32, peer.ip().to_string(), peer.port() as u32)
                    .await
                else {
                    return;
                };
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            });
        }
    });

    Ok(Tunnel { local_port, task })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_key_is_reported_with_its_fingerprint() {
        let seen = Some("SHA256:abc".to_string());
        assert_eq!(host_key_error(&None, &seen).as_deref(), Some("HYRAX_SSH_UNKNOWN_KEY:SHA256:abc"));
    }

    #[test]
    fn changed_key_is_reported_as_a_possible_attack_not_as_unknown() {
        let seen = Some("SHA256:new".to_string());
        let expected = Some("SHA256:old".to_string());
        assert_eq!(host_key_error(&expected, &seen).as_deref(), Some("HYRAX_SSH_CHANGED_KEY:SHA256:new"));
    }

    #[test]
    fn matching_key_is_not_an_error_and_no_key_seen_means_a_network_error() {
        let fp = Some("SHA256:same".to_string());
        assert_eq!(host_key_error(&fp, &fp), None);
        assert_eq!(host_key_error(&None, &None), None);
    }

    #[test]
    fn tilde_is_expanded_only_at_the_start_of_a_path() {
        let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap();
        let home = home.trim_end_matches(['/', '\\']).to_string();
        assert_eq!(expand_home("~/.ssh/id"), format!("{home}/.ssh/id"));
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("C:/x/~/y"), "C:/x/~/y");
        assert_eq!(expand_home("~otro/x"), "~otro/x");
    }

    #[test]
    fn host_and_user_are_required() {
        let mut ssh = SshSettings::default();
        assert!(validate(&ssh).unwrap_err().contains("host"));
        ssh.host = "h".into();
        assert!(validate(&ssh).unwrap_err().contains("usuario"));
        ssh.user = "u".into();
        assert!(validate(&ssh).is_ok());
    }

    /// Necesita un sshd y un Postgres desechables: `HYRAX_SSH_TEST_{PORT,USER,KEY,WRONG_KEY,FP}` y `HYRAX_WRITE_TEST_*`.
    /// Solo lee (`SELECT`) de la base `scratch`.
    #[tokio::test]
    #[ignore = "necesita un sshd y un Postgres desechables"]
    async fn tunnel_reaches_postgres_and_pins_the_host_key() {
        let var = |n: &str| std::env::var(n).unwrap_or_else(|_| panic!("falta {n}"));
        let ssh = SshSettings {
            enabled: true,
            host: "127.0.0.1".into(),
            port: var("HYRAX_SSH_TEST_PORT").parse().unwrap(),
            user: var("HYRAX_SSH_TEST_USER"),
            key_path: Some(var("HYRAX_SSH_TEST_KEY")),
            fingerprint: None,
            ..Default::default()
        };
        let mut profile = crate::testing::profile(true);
        let pg_port = profile.port;

        // 1. Sin huella guardada: se niega y devuelve la huella para confirmarla.
        profile.ssh = ssh.clone();
        let err = crate::db::connect(&profile).await.err().expect("debía fallar");
        assert_eq!(err, format!("{UNKNOWN_KEY}:{}", var("HYRAX_SSH_TEST_FP")));

        // 2. Con otra huella: es un cambio de clave, no una clave desconocida.
        profile.ssh.fingerprint = Some("SHA256:otra".into());
        let err = crate::db::connect(&profile).await.err().expect("debía fallar");
        assert!(err.starts_with(CHANGED_KEY), "{err}");

        // 3. Con la huella correcta pero una clave de usuario no autorizada: rechazo.
        profile.ssh.fingerprint = Some(var("HYRAX_SSH_TEST_FP"));
        profile.ssh.key_path = Some(var("HYRAX_SSH_TEST_WRONG_KEY"));
        let err = crate::db::connect(&profile).await.err().expect("debía fallar");
        assert!(err.contains("rechazó"), "{err}");

        // 4. Todo correcto: la sesión de Postgres viaja por el túnel.
        profile.ssh.key_path = Some(var("HYRAX_SSH_TEST_KEY"));
        let session = crate::db::connect(&profile).await.expect("debía conectar");
        let tunnel = session.tunnel.as_ref().expect("la sesión debe llevar el túnel");
        assert_ne!(tunnel.local_port, pg_port);
        assert_eq!(
            crate::testing::value(&session, "SELECT current_setting('port')").await.as_deref(),
            Some(pg_port.to_string().as_str())
        );
        assert!(crate::db::is_read_only(&session.client).await.unwrap());

        // 5. Si el servidor SSH no alcanza el destino, el error lo dice con claridad desde el principio.
        let mut unreachable = profile.clone();
        unreachable.port = 1;
        let err = crate::db::connect(&unreachable).await.err().expect("debía fallar");
        assert!(err.contains("reenvío hacia 127.0.0.1:1") || err.contains("reenviar hacia 127.0.0.1:1"), "{err}");

        // 6. Al soltar la sesión se cierra el puerto local.
        let local = tunnel.local_port;
        drop(session);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", local)).await.is_err());
    }
}
