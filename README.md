<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Logo de Hyrax Studio" width="120" />
</p>

<h1 align="center">Hyrax Studio</h1>

<p align="center">
  Cliente de bases de datos de escritorio, ligero y pensado para no romper producción.<br />
  Hoy para PostgreSQL; MongoDB y otras bases NoSQL están en el plan.<br />
  Rust + Tauri 2 en el backend, React + TypeScript en la interfaz.
</p>

> **Estado: versión temprana (0.1).** Se usa a diario en desarrollo, pero todavía no se ha probado contra un clúster de producción real ni fuera de Windows. Antes de usarlo en serio, lee [Limitaciones actuales](#limitaciones-actuales).

## Por qué Hyrax Studio

DataGrip y DBeaver hacen mucho; a veces demasiado, y pesan. Hyrax Studio apunta a lo que se usa todos los días (navegar el esquema, consultar, revisar y corregir datos) con un binario pequeño, arranque inmediato y poca memoria. Y con una regla de diseño: **un clic equivocado no debería costar una tabla**. Por eso arranca en solo lectura, pide confirmación para escribir y enseña el SQL exacto antes de aplicar cualquier cambio.

## Qué hace

**Navegar**
- Árbol servidor → bases de datos → schemas → tablas/vistas → columnas, con carga perezosa y filtro.
- `Ctrl+N` salta a cualquier tabla, vista, función, procedimiento o secuencia por nombre; `Ctrl+Mayús+A` abre la paleta de comandos.
- DDL de tablas, vistas, funciones y secuencias, generado desde el catálogo.
- Las claves foráneas son navegables en ambos sentidos: de un valor al registro relacionado y, desde una fila, a quién la referencia.
- Pestaña **Estructura**: columnas, claves, índices, constraints, triggers, estadísticas y tamaño.

**Consultar**
- Editor SQL con resaltado, autocompletado (alias, `JOIN` sugerido por claves foráneas, funciones con su firma, plantillas), historial, formato y buscar y reemplazar.
- `Ctrl+Enter` ejecuta la sentencia bajo el cursor; `Ctrl+Mayús+Enter`, todo el script. Parámetros `:nombre`, límite de tiempo, cancelar.
- Plan de ejecución en árbol (Explicar/Analizar) con el nodo más costoso resaltado y aviso de estimaciones erradas.
- Abrir y guardar scripts como archivos `.sql`.

**Trabajar con datos**
- Visor de tablas con paginación, orden por varias columnas, filtros por columna (`>5`, `=x`, `^x`, `null`…), conteo estimado o exacto e inspector de celdas con JSON formateado.
- **Edición segura**: celdas, filas nuevas y eliminadas quedan como cambios pendientes; se revisa el SQL y se aplican todos juntos en una transacción, con control de cambios concurrentes.
- Importar CSV/TSV/JSON con asignación de columnas y ensayo previo; exportar a CSV, JSON o `INSERT` en streaming.
- Fijar y comparar resultados; vista de fila como formulario.
- Clic derecho en tablas, vistas y bases de datos: abrir, ver DDL, nueva consulta, copiar nombre y eliminar (pide escritura habilitada, muestra el SQL y exige escribir el nombre).

**Conectar**
- Conexiones guardadas, con pegado de cadenas `postgresql://usuario:clave@host:5432/base?sslmode=…`.
- **Túnel SSH** con clave privada o contraseña. La clave del servidor SSH no se acepta a ciegas: la primera vez se muestra su huella SHA-256 para que la confirmes, queda fijada en la conexión y, si cambia, Hyrax se niega a conectar.

**Seguridad**
- Solo lectura por defecto; la escritura se confirma y caduca sola a los 10 minutos, comprobado en el servidor.
- Conexiones marcables como **producción**, con confirmación reforzada.
- Contraseñas en el almacén de credenciales del sistema, nunca en archivos. TLS con verificación de certificado.
- Aviso ante `DELETE`/`UPDATE` sin `WHERE`, `DROP` y `TRUNCATE`, y "Probar (ROLLBACK)" para ver el efecto sin guardar nada.
- Detalle y riesgos residuales en [docs/SEGURIDAD.md](docs/SEGURIDAD.md).

Temas oscuro, claro o automático. Tipografías Inter y JetBrains Mono incluidas en la app.

## Limitaciones actuales

Lo que hay que saber antes de confiar en Hyrax:

**Seguridad**
- **El modo solo lectura de la aplicación es un guardarraíl, no una barrera.** Quien conozca Postgres puede encontrar formas de saltárselo (por ejemplo, funciones del lado del servidor). La protección real es conectarse con una cuenta de base de datos **sin permisos de escritura**.
- La confirmación de producción solo funciona si marcas la conexión como producción; Hyrax no lo adivina.
- Con `ssl=require` (sin verificar) un intermediario podría suplantar al servidor. Usa "Cifrado y verificar el certificado".
- El historial de consultas se guarda en claro en tu equipo mientras esté activado.
- Con un túnel SSH abierto, el puerto local (solo `127.0.0.1`) acepta conexiones de cualquier proceso de tu equipo mientras dure la sesión, como en cualquier reenvío de puertos; Postgres sigue pidiendo su propia autenticación.
- El túnel se probó contra un `sshd` local con clave privada; la contraseña SSH y la verificación TLS a través del túnel no se han probado de punta a punta. Cada base abierta de una conexión con túnel abre su propia sesión SSH.
- Dependencias: `cargo audit` marca `crypto-bigint` (variaciones de tiempo, vía `russh`) sin corrección disponible todavía; detalle en [docs/SEGURIDAD.md](docs/SEGURIDAD.md).

**Madurez**
- Solo probado en **Windows**. Linux y macOS no se han probado.
- No se ha probado contra un clúster de producción real, solo contra instancias desechables de PostgreSQL 17.
- No hay instalador firmado ni actualizaciones automáticas todavía.
- Requiere PostgreSQL 11 o superior.

**Datos y rendimiento**
- Todos los valores se muestran como texto (protocolo simple de Postgres); no hay tipos nativos en la rejilla.
- Un resultado de más de 100.000 filas se cancela en el servidor y se muestra como "100.000+"; en pantalla se guardan hasta 5.000 filas por resultado.
- La importación admite hasta 200.000 filas o 64 MB por archivo, en UTF-8.
- La edición exige tablas con **clave primaria**; las vistas son de solo lectura.
- Comparar resultados solo compara las filas cargadas (hasta 5.000), no tablas completas.
- Los parámetros `:nombre` se sustituyen como literales escapados, no como parámetros enlazados, y no se detectan dentro de cadenas, comentarios ni bloques `$$`.

**Funcionalidad que aún no existe**
- Túnel SSH con `ssh-agent`, saltos (`ProxyJump`) o lectura de `~/.ssh/known_hosts`: hoy solo clave privada en archivo o contraseña, con la huella fijada en la conexión. Cadenas de conexión con otros parámetros de libpq además de `sslmode` y `sslrootcert`.
- Importar conexiones desde DBeaver o pgAdmin.
- Diagrama ER, comparación de esquemas, monitor de sesiones, gestión de roles y privilegios.
- Eliminar schemas; "Ir a objeto" no incluye índices, constraints ni triggers como entradas propias.
- Autocompletado de palabras clave según el contexto, panel de scripts y plantillas propias.
- Otros motores: solo PostgreSQL. MongoDB está contemplado para más adelante.

El plan completo está en [docs/ROADMAP.md](docs/ROADMAP.md).

## Uso recomendado en producción

1. Conéctate con una cuenta de base de datos **sin permisos de escritura** (en [docs/SEGURIDAD.md](docs/SEGURIDAD.md) hay un rol de ejemplo).
2. Elige "Cifrado y verificar el certificado".
3. Marca la conexión como producción.
4. Habilita la escritura solo cuando haga falta y revisa siempre el SQL antes de aplicar.

## Ejecutar desde el código

Requisitos: Rust (MSVC en Windows), Node 20+ y WebView2 (incluido en Windows 11).

```
npm install
npm run tauri dev      # desarrollo
npm run tauri build    # instalador
```

## Pruebas

```
npm test                         # interfaz, con backend simulado
cd src-tauri && cargo test       # unitarias del backend
```

Las pruebas de integración del backend están marcadas `#[ignore]` y necesitan servidores reales. Las de lectura usan `HYRAX_TEST_HOST/PORT/DB/USER/PASSWORD`. Las de **escritura** usan `HYRAX_WRITE_TEST_*` y se niegan a correr si la base no se llama `scratch`: úsalas solo con un Postgres desechable, nunca con datos reales. Las de TLS necesitan además `HYRAX_TLS_CA_PATH`.

```
cargo test -- --include-ignored
```

## Documentación

- [docs/ROADMAP.md](docs/ROADMAP.md): etapas hechas y pendientes.
- [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md): estructura y decisiones.
- [docs/SEGURIDAD.md](docs/SEGURIDAD.md): revisión de seguridad y riesgos residuales.
- [SECURITY.md](SECURITY.md): cómo informar vulnerabilidades.

## Estado del proyecto y contribuciones

Hyrax es un proyecto personal en desarrollo activo. Los reportes de errores son bienvenidos; para problemas de seguridad usa el canal privado descrito en [SECURITY.md](SECURITY.md), no un issue público.

## Licencia

[MIT](LICENSE).
