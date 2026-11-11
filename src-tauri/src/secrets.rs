use keyring::{Entry, Error};

const SERVICE: &str = "hyrax";

fn entry(profile_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, profile_id)
        .map_err(|e| format!("No se pudo acceder al almacén de credenciales del sistema: {e}"))
}

pub fn set(profile_id: &str, password: &str) -> Result<(), String> {
    entry(profile_id)?
        .set_password(password)
        .map_err(|e| format!("No se pudo guardar la contraseña en el almacén del sistema: {e}"))
}

/// Nombre del servicio antes de llamarse Hyrax; se lee una vez y se migra.
const LEGACY_SERVICE: &str = "pgdesk";

pub fn get(profile_id: &str) -> Result<Option<String>, String> {
    match entry(profile_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(Error::NoEntry) if !profile_id.starts_with("ssh:") => migrate_legacy(profile_id),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("No se pudo leer la contraseña del almacén del sistema: {e}")),
    }
}

fn migrate_legacy(profile_id: &str) -> Result<Option<String>, String> {
    let Ok(old) = Entry::new(LEGACY_SERVICE, profile_id) else {
        return Ok(None);
    };
    let Ok(password) = old.get_password() else {
        return Ok(None);
    };
    set(profile_id, &password)?;
    let _ = old.delete_credential();
    Ok(Some(password))
}

/// Borra también la entrada que dejó la versión anterior (servicio `pgdesk`), si existe.
pub fn delete_legacy(profile_id: &str) -> Result<(), String> {
    let Ok(entry) = Entry::new(LEGACY_SERVICE, profile_id) else {
        return Ok(());
    };
    match entry.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("No se pudo borrar una contraseña antigua del almacén del sistema: {e}")),
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
        let id = format!("hyrax-test-{}", std::process::id());
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

    #[test]
    fn legacy_pgdesk_password_is_moved_to_the_new_service_on_first_read() {
        let id = format!("hyrax-legacy-{}", std::process::id());
        let _ = delete(&id);
        let old = Entry::new(LEGACY_SERVICE, &id).unwrap();
        old.set_password("clave vieja").unwrap();

        assert_eq!(get(&id).unwrap().as_deref(), Some("clave vieja"));
        // Quedó en el servicio nuevo y se borró del viejo.
        assert!(matches!(old.get_password(), Err(Error::NoEntry)));
        assert_eq!(Entry::new(SERVICE, &id).unwrap().get_password().unwrap(), "clave vieja");

        delete(&id).unwrap();
    }

    #[test]
    fn delete_legacy_removes_only_the_old_service_entry() {
        let id = format!("hyrax-legacy-del-{}", std::process::id());
        let _ = delete(&id);
        Entry::new(LEGACY_SERVICE, &id).unwrap().set_password("vieja").unwrap();
        set(&id, "nueva").unwrap();

        delete_legacy(&id).unwrap();
        assert!(matches!(Entry::new(LEGACY_SERVICE, &id).unwrap().get_password(), Err(Error::NoEntry)));
        assert_eq!(get(&id).unwrap().as_deref(), Some("nueva"));
        delete_legacy(&id).unwrap(); // sin entrada: no es un error

        delete(&id).unwrap();
    }
}
