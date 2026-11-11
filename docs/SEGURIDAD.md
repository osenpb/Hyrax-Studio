# Revisión de seguridad (2026-11-10)

Alcance: PgDesk v0.1 tras las etapas 1–8, pensando en su uso contra bases de producción. Método: lectura del código (construcción de SQL, datos que cruzan al webview, almacenamiento de credenciales, TLS, configuración de Tauri), auditoría de dependencias (`npm audit`, `cargo audit`) y pruebas contra Postgres reales, incluida una prueba de punta a punta con la aplicación real manejada por el depurador de WebView2.

## Resumen

No se encontraron vulnerabilidades explotables en las dependencias ni inyección SQL. Sí había cuatro problemas de diseño que importaban para producción, todos corregidos (S-01 a S-04), más varios endurecimientos menores. Lo que sigue siendo cierto: el modo solo lectura de la aplicación es una red de seguridad contra errores, **no** una barrera contra alguien que quiera escribir; para producción la barrera real es una cuenta de base de datos sin permisos de escritura (ver "Recomendaciones").

## Hallazgos

| ID | Severidad | Hallazgo | Estado |
|---|---|---|---|
| S-01 | Alta | Las contraseñas se guardaban en texto plano en `profiles.json` y además se enviaban al webview con cada listado de conexiones | **Corregido.** Van al Administrador de credenciales de Windows (Keychain / Secret Service en otros sistemas). Nunca llegan al webview (solo un indicador "tiene contraseña"). El archivo no las contiene (hay un test que lo comprueba). Las contraseñas antiguas se migran solas, releyéndolas antes de borrarlas del archivo |
| S-02 | Alta | "SSL requerido" cifraba pero aceptaba cualquier certificado: vulnerable a un intermediario | **Mitigado.** Nuevo modo "Cifrado y verificar el certificado" (cadena y nombre de host; CA propia opcional). El modo sin verificar sigue existiendo con un aviso visible. Probado contra un servidor con certificado autofirmado: sin la CA rechaza, con la CA conecta |
| S-03 | Alta | El modo solo lectura se podía apagar con SQL (`SET default_transaction_read_only = off`, `BEGIN READ WRITE`, `set_config`, `RESET ALL`, `DO`…) | **Corregido contra descuidos.** El servidor de PgDesk rechaza esas sentencias mientras la sesión está en solo lectura. No es una barrera contra un atacante: ver riesgos residuales |
| S-04 | Media | La confirmación de producción (escribir el nombre de la base) solo existía en la interfaz | **Corregido.** El backend la exige y rechaza el intento aunque se llame directamente al comando (comprobado en la aplicación real) |
| S-05 | Media | Sin política de seguridad de contenido (CSP) en la ventana | **Corregido.** CSP estricta: sin `unsafe-eval`, sin scripts en línea, sin conexiones ni imágenes ni marcos externos. Verificada en un binario con los recursos embebidos |
| S-06 | Media | La vuelta automática a solo lectura a los 10 minutos dependía de un temporizador de la interfaz | **Corregido.** Además se aplica en el servidor en cada operación |
| S-07 | Media | En producción se podían lanzar consultas sin límite de tiempo | **Corregido.** Tope de 5 minutos impuesto en el servidor y la opción "Sin límite" no se ofrece en producción |
| S-08 | Baja | La ruta de exportación no se validaba en el backend | **Corregido.** Debe ser absoluta, terminar en la extensión del formato, y la carpeta debe existir |
| S-09 | Baja | El historial de consultas se guarda sin cifrar en el almacenamiento local de la ventana y puede contener datos sensibles | **Mitigado.** Interruptor "Guardar historial" y borrado automático al eliminar una conexión. No se cifra |
| S-10 | Info | Dependencias | `npm audit`: 0 vulnerabilidades. `cargo audit`: 0 vulnerabilidades y 5 avisos informativos (`glib`, `proc-macro-error`, `zbus*`), todos de código que solo se compila en Linux |
| S-11 | Info | Inyección SQL | Revisados todos los puntos que construyen SQL. Identificadores con `quote_ident`; valores de filtros como literales escapados (`E'...'` si hay barras); cambios de datos con parámetros enlazados; los tipos de columna salen del catálogo del servidor, nunca del cliente; el número de filas, tiempos y modos son números o constantes |
| S-12 | Aceptado | La CSP permite estilos en línea | Lo necesitan React y CodeMirror. No permite ejecutar código |
| S-13 | Aceptado | Quien controle tu sesión de Windows puede leer el Administrador de credenciales | Es el límite de confianza normal de cualquier cliente de bases de datos |
| S-14 | Pendiente | Sin firma de código ni actualizaciones automáticas | Para la distribución pública |

## Controles que protegen en producción

- Las conexiones nuevas abren en **solo lectura**. Habilitar la escritura exige confirmación; en una conexión marcada como **producción** hay que escribir el nombre de la base, y el servidor lo vuelve a comprobar.
- La escritura se apaga sola a los 10 minutos, en el servidor.
- Los cambios de datos se preparan en pantalla y se aplican **todos juntos en una transacción** tras revisar el SQL. Cada fila se comprueba contra su valor original: si alguien más la cambió, no se aplica nada. Solo tablas con clave primaria.
- En el editor SQL: aviso antes de ejecutar `DELETE`/`UPDATE` sin `WHERE`, `TRUNCATE` o `DROP`, y un "Probar (ROLLBACK)" que ejecuta y revierte para ver el efecto sin guardar nada.
- Tiempo máximo por consulta (60 s por defecto, 5 min como tope en producción), cancelación, y lecturas con tope de filas en memoria.
- `EXPLAIN ANALYZE` (que ejecuta la consulta) solo está disponible en solo lectura.
- Permisos mínimos de la ventana: solo el diálogo "guardar archivo". Sin acceso al sistema de archivos ni a la red desde la interfaz.

## Riesgos residuales y límites

1. **El solo lectura es un guardarraíl.** Se implementa con `default_transaction_read_only` de Postgres más un filtro de sentencias. Un usuario con conocimiento puede encontrar otra forma de saltárselo (por ejemplo, funciones del lado del servidor). No lo uses como única protección frente a alguien que quiera escribir.
2. **La confirmación de producción depende de que marques la conexión como producción.** PgDesk no puede adivinarlo.
3. **Si usas `ssl=require`** (sin verificar), un intermediario en la red puede suplantar al servidor.
4. **El historial de consultas** queda en claro en tu equipo mientras esté activado.
5. **No se probó** contra un clúster de producción real, ni en Linux ni en macOS, ni con un instalador firmado. La prueba de punta a punta usó un Postgres desechable y una compilación con los recursos embebidos, no un instalador.
6. **No se probó la conexión de tu servidor local existente** tras migrar su contraseña al almacén del sistema (no conozco esa contraseña). Ábrela y comprueba que conecta.

## Recomendaciones para producción

Crea una cuenta que no pueda escribir; es la única barrera real:

```sql
CREATE ROLE pgdesk_ro LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE nombre_de_la_base TO pgdesk_ro;
GRANT pg_read_all_data TO pgdesk_ro;
ALTER ROLE pgdesk_ro SET default_transaction_read_only = on;
ALTER ROLE pgdesk_ro SET statement_timeout = '60s';
ALTER ROLE pgdesk_ro SET idle_in_transaction_session_timeout = '30s';
```

(`pg_read_all_data` requiere PostgreSQL 14 o superior; en versiones anteriores hay que dar `SELECT` por esquema.)

- Conecta con **"Cifrado y verificar el certificado"** y, si la CA es propia, indica su archivo PEM.
- Marca la conexión como **producción**.
- Usa una cuenta de escritura distinta, con vida corta, solo cuando haga falta editar.
- Prefiere llegar al servidor por VPN o túnel; no lo expongas a Internet.

## Para publicar el repositorio

- Revisado: no hay contraseñas, direcciones de servidores ni rutas personales en los archivos versionados.
- Los commits llevan el nombre y el correo configurados en git en tu equipo; si no quieres que el correo sea público, cámbialo antes de publicar (`git config user.email`, y reescribe el historial si ya hay commits).
- Falta elegir una **licencia**.
- `SECURITY.md` indica cómo informar problemas; ajusta el medio de contacto cuando exista el repositorio.

## Cómo se verificó

- Backend: 40 pruebas (unitarias y de integración contra Postgres reales: lecturas contra la base local, escrituras, TLS y caducidad contra una base desechable) y escaneo de dependencias.
- Interfaz: 49 pruebas con backend simulado, repetidas varias veces para descartar fallos intermitentes.
- Aplicación real: migración de credenciales, conexión TLS verificada, edición con aplicación real y comprobación en la base, confirmación de producción, rechazo del servidor ante intentos de saltársela, capturas de ambos temas y sondas de la CSP.
