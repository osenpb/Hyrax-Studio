//! Construcción de la URI de conexión a MongoDB a partir de un perfil.
//!
//! La URI **no lleva credenciales**: usuario y contraseña se ponen aparte en las opciones del cliente, así la
//! contraseña no aparece en ninguna cadena que pueda acabar en un mensaje de error o en un registro.

use crate::models::{ConnectionProfile, Engine};

fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    // IPv6 entre corchetes, o nombre DNS / IPv4
    if let Some(inner) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return !inner.is_empty() && inner.chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.');
    }
    host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// Acepta `host` o `host:puerto` (el puerto, entre 1 y 65535).
fn valid_host_port(entry: &str) -> bool {
    let (host, port) = match entry.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(':') && !(h.starts_with('[') && !h.ends_with(']')) && p.chars().all(|c| c.is_ascii_digit()) => {
            (h, Some(p))
        }
        _ => (entry, None),
    };
    if let Some(p) = port {
        match p.parse::<u32>() {
            Ok(n) if (1..=65535).contains(&n) => {}
            _ => return false,
        }
    }
    valid_host(host)
}

fn valid_token(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

pub fn build_uri(profile: &ConnectionProfile) -> Result<String, String> {
    if profile.engine != Engine::Mongodb {
        return Err("La conexión no es de MongoDB.".to_string());
    }
    let host = profile.host.trim();
    let mongo = &profile.mongo;

    let mut params: Vec<String> = Vec::new();
    if let Some(rs) = mongo.replica_set.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if !valid_token(rs) {
            return Err("El nombre del conjunto de réplicas solo admite letras, números, punto, guion y guion bajo.".to_string());
        }
        params.push(format!("replicaSet={rs}"));
    }
    if mongo.direct_connection {
        params.push("directConnection=true".to_string());
    }
    let query = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };

    if profile.port == 0 {
        return Err("Falta el puerto.".to_string());
    }
    let first = if host.starts_with('[') || !host.contains(':') {
        format!("{host}:{}", profile.port)
    } else {
        return Err("Escribe el host sin puerto; el puerto va en su propio campo.".to_string());
    };
    if !valid_host_port(&first) {
        return Err("El host no es válido.".to_string());
    }
    let mut hosts = vec![first];
    for entry in mongo.extra_hosts.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if !valid_host_port(entry) {
            return Err(format!("El nodo «{entry}» no es válido (usa host o host:puerto)."));
        }
        hosts.push(if entry.rsplit_once(':').is_some_and(|(_, p)| p.chars().all(|c| c.is_ascii_digit())) && !entry.ends_with(']') {
            entry.to_string()
        } else {
            format!("{entry}:27017")
        });
    }
    Ok(format!("mongodb://{}/{query}", hosts.join(",")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::MongoSettings;

    fn profile(host: &str, port: u16, mongo: MongoSettings) -> ConnectionProfile {
        let mut p: ConnectionProfile = serde_json::from_str(&format!(
            r#"{{"id":"m","name":"m","host":"{host}","port":{port},"database":"","user":"u","engine":"mongodb"}}"#
        ))
        .unwrap();
        p.mongo = mongo;
        p
    }

    #[test]
    fn builds_a_plain_uri_without_credentials() {
        let p = profile("localhost", 27017, MongoSettings::default());
        assert_eq!(build_uri(&p).unwrap(), "mongodb://localhost:27017/");
    }

    #[test]
    fn replica_set_extra_hosts_and_default_port() {
        let m = MongoSettings {
            extra_hosts: "db2.example.com:27018, db3.example.com".into(),
            replica_set: Some("rs0".into()),
            ..Default::default()
        };
        let p = profile("db1.example.com", 27017, m);
        assert_eq!(
            build_uri(&p).unwrap(),
            "mongodb://db1.example.com:27017,db2.example.com:27018,db3.example.com:27017/?replicaSet=rs0"
        );
    }

    #[test]
    fn hosts_that_could_inject_uri_parts_are_rejected() {
        let m = MongoSettings::default();
        for bad in ["a/b", "a@b", "a?x=1", "a b", "a,b", "host#frag", ""] {
            assert!(build_uri(&profile(bad, 27017, m.clone())).is_err(), "{bad}");
        }
        let extra = MongoSettings { extra_hosts: "ok.example.com,evil/host".into(), ..Default::default() };
        assert!(build_uri(&profile("h", 27017, extra)).is_err());
        let rs = MongoSettings { replica_set: Some("rs0&tls=false".into()), ..Default::default() };
        assert!(build_uri(&profile("h", 27017, rs)).is_err());
    }

    #[test]
    fn ipv6_and_port_validation() {
        let m = MongoSettings::default();
        assert_eq!(build_uri(&profile("[::1]", 27017, m.clone())).unwrap(), "mongodb://[::1]:27017/");
        assert!(build_uri(&profile("localhost", 0, m.clone())).is_err());
        let extra = MongoSettings { extra_hosts: "h2:99999".into(), ..Default::default() };
        assert!(build_uri(&profile("h", 27017, extra)).is_err());
    }

    #[test]
    fn a_postgres_profile_is_refused() {
        let mut p = profile("h", 5432, MongoSettings::default());
        p.engine = Engine::Postgres;
        assert!(build_uri(&p).is_err());
    }
}
