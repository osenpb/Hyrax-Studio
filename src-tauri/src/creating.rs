use crate::db::{self, quote_ident};
use crate::models::ConnectionProfile;

/// `CREATE DATABASE` con el nombre entre comillas: cualquier carácter queda dentro del identificador.
pub fn create_database_sql(name: &str) -> Result<String, String> {
    if name.is_empty() {
        return Err("Falta el nombre de la base de datos.".to_string());
    }
    // PostgreSQL limita los identificadores a 63 bytes y no admite el byte nulo.
    if name.len() > 63 || name.contains('\0') {
        return Err("El nombre de la base de datos debe tener entre 1 y 63 bytes y no puede contener caracteres nulos.".to_string());
    }
    Ok(format!("CREATE DATABASE {}", quote_ident(name)))
}

/// Crea la base desde una sesión de mantenimiento propia (`postgres`, o `template1` si no existe).
pub async fn create_database(profile: &ConnectionProfile, name: &str) -> Result<String, String> {
    let sql = create_database_sql(name)?;
    let mut maintenance = profile.clone();
    maintenance.read_only = false;
    maintenance.production = false;
    maintenance.database = "postgres".to_string();
    let session = match db::connect(&maintenance).await {
        Ok(session) => session,
        Err(_) => {
            maintenance.database = "template1".to_string();
            db::connect(&maintenance).await?
        }
    };
    session.client.batch_execute(&sql).await.map_err(|e| db::describe(&e))?;
    Ok(sql)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_quoted_statement() {
        assert_eq!(create_database_sql("shop").unwrap(), "CREATE DATABASE \"shop\"");
        assert_eq!(create_database_sql("mi base").unwrap(), "CREATE DATABASE \"mi base\"");
    }

    #[test]
    fn an_injected_name_stays_inside_its_identifier() {
        assert_eq!(
            create_database_sql("x\"; DROP DATABASE y; --").unwrap(),
            "CREATE DATABASE \"x\"\"; DROP DATABASE y; --\""
        );
    }

    #[test]
    fn refuses_empty_too_long_and_nul_names() {
        assert!(create_database_sql("").is_err());
        assert!(create_database_sql(&"a".repeat(64)).is_err());
        assert!(create_database_sql(&"a".repeat(63)).is_ok());
        assert!(create_database_sql("a\0b").is_err());
    }
}
