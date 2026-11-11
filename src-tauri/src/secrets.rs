use keyring::{Entry, Error};

const SERVICE: &str = "pgdesk";

fn entry(profile_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, profile_id)
        .map_err(|e| format!("No se pudo acceder al almacén de credenciales del sistema: {e}"))
}

pub fn set(profile_id: &str, password: &str) -> Result<(), String> {
    entry(profile_id)?
        .set_password(password)
        .map_err(|e| format!("No se pudo guardar la contraseña en el almacén del sistema: {e}"))
}

pub fn get(profile_id: &str) -> Result<Option<String>, String> {
    match entry(profile_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("No se pudo leer la contraseña del almacén del sistema: {e}")),
    }
}

pub fn delete(profile_id: &str) -> Result<(), String> {
    match entry(profile_id)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("No se pudo borrar la contraseña del almacén del sistema: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_roundtrip_through_the_os_vault() {
        let id = format!("pgdesk-test-{}", std::process::id());
        let _ = delete(&id);
        assert_eq!(get(&id).unwrap(), None);

        set(&id, "s3cr3t con ñ y \"comillas\"").unwrap();
        assert_eq!(get(&id).unwrap().as_deref(), Some("s3cr3t con ñ y \"comillas\""));

        set(&id, "otra").unwrap();
        assert_eq!(get(&id).unwrap().as_deref(), Some("otra"));

        delete(&id).unwrap();
        assert_eq!(get(&id).unwrap(), None);
        delete(&id).unwrap();
    }
}
