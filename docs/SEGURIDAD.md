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

## Actualización (2026-11-11): etapas 9 a 11

Superficie nueva y cómo se acotó. Esta actualización es una revisión del diseño y de las pruebas; no repite la auditoría de dependencias de S-10.

| Función | Riesgo considerado | Control |
|---|---|---|
| Abrir y guardar scripts, abrir archivos para importar | Que la interfaz web leyera o escribiera rutas arbitrarias | Los diálogos se abren desde Rust y la ruta nunca viene de la interfaz. Solo se vuelve a guardar sobre rutas que el usuario eligió en un diálogo durante la sesión. Tamaño máximo (8 MB scripts, 64 MB datos) y UTF-8 obligatorio. No se añadió ningún permiso a la ventana |
| Importar | Escribir datos sin querer o dejar la tabla a medias | Requiere escritura habilitada (y por tanto la confirmación de producción), toma el cerrojo de escritura de la sesión, valida columnas contra el catálogo, usa parámetros enlazados con el tipo sacado del catálogo, y todo ocurre en una transacción: un error revierte todo. «Ensayar» termina en `ROLLBACK`. Solo tablas (no vistas ni tablas del sistema). Máximo 200.000 filas por importación |
| Parámetros `:nombre` | Inyección SQL por el valor | Se sustituyen como literales escapados (comillas duplicadas, `E'…'` con barras, NUL rechazado), con prueba de que `x'; DROP TABLE t; --` queda dentro de su literal. El aviso de sentencias peligrosas y el filtro de solo lectura se aplican al texto final. El valor lo escribe el propio usuario sobre su SQL, así que no abre un canal nuevo |
| Estructura, DDL y búsqueda de objetos | Escritura o carga excesiva | Solo consultas de catálogo de lectura, válidas en sesiones de solo lectura. Tope de 20.000 objetos |
| Ejecutar la sentencia del cursor | Ejecutar de más (o de menos) | Ctrl+Enter solo corre la sentencia actual o la selección, lo que reduce el riesgo de lanzar un script entero por descuido; «Ejecutar todo» es explícito y pasa por el mismo aviso de sentencias peligrosas |
| Resultados fijados | Datos sensibles en memoria | Viven solo en memoria de la ventana (máximo 8) y se pierden al cerrar; no se guardan en disco |

### Eliminar tablas, vistas y bases de datos (menú contextual)

| Riesgo | Control |
|---|---|
| Eliminar algo por un clic equivocado | Acción solo desde el menú de clic derecho, nunca como botón visible. Diálogo que muestra el SQL exacto y exige **escribir el nombre completo**. El backend lo vuelve a exigir (`check_confirm`), aunque se llame al comando directamente |
| Eliminar en una sesión de solo lectura | El backend rechaza si la sesión está en solo lectura. Para una base de datos exige que haya escritura habilitada en alguna base de ese servidor. Habilitarla desde el diálogo pasa por la misma confirmación de producción (escribir el nombre de la base) |
| Borrar de más con `CASCADE` | Es una casilla aparte, apagada por defecto, y el SQL mostrado lo refleja. Sin ella, si algo depende del objeto, falla y no se borra nada |
| Dejar un bloqueo colgado | `lock_timeout` de 5 s dentro de una transacción; si falla se revierte |
| Inyección por el nombre | Identificadores con `quote_ident` (con prueba de un nombre malicioso). Solo se acepta un conjunto fijo de tipos de objeto; se rechazan los schemas del sistema y las bases plantilla |
| Eliminar una base a la que uno mismo está conectado | PgDesk cierra su propia sesión a esa base y elimina desde una conexión de mantenimiento (`postgres`, o `template1` si se elimina `postgres`). Si hay otras conexiones ajenas, falla con un mensaje claro; «Forzar» (`WITH (FORCE)`, PostgreSQL 13+) las desconecta y es una casilla aparte |

Esto **no** sustituye a la cuenta sin permisos de escritura: con una cuenta de solo lectura, el servidor rechaza todo esto de todos modos. Tampoco hay papelera ni deshacer: si no hay copia de seguridad, lo eliminado no vuelve.

Riesgo residual nuevo: el contenido de un CSV/JSON importado se inserta tal cual; si contiene datos que el usuario no debería cargar, PgDesk no lo detecta. La vista previa y el ensayo existen para revisarlo antes.

## Controles que protegen en producción

- Las conexiones nuevas abren en **solo lectura**. Habilitar la escritura exige confirmación; en una conexión marcada como **producción** hay que escribir el nombre de la base, y el servidor lo vuelve a comprobar.
- La escritura se apaga sola a los 10 minutos, en el servidor.
- Los cambios de datos se preparan en pantalla y se aplican **todos juntos en una transacción** tras revisar el SQL. Cada fila se comprueba contra su valor original: si alguien más la cambió, no se aplica nada. Solo tablas con clave primaria.
- En el editor SQL: aviso antes de ejecutar `DELETE`/`UPDATE` sin `WHERE`, `TRUNCATE` o `DROP`, y un "Probar (ROLLBACK)" que ejecuta y revierte para ver el efecto sin guardar nada.
- Tiempo máximo por consulta (60 s por defecto, 5 min como tope en producción), cancelación, y lecturas con tope de filas en memoria.
- `EXPLAIN ANALYZE` (que ejecuta la consulta) solo está disponible en solo lectura.
- Permisos mínimos de la ventana: solo el diálogo "guardar archivo". Sin acceso al sistema de archivos ni a la red desde la interfaz (abrir y guardar scripts o datos pasa por comandos de Rust que abren su propio diálogo).

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

- Backend: 51 pruebas (31 unitarias y 20 de integración contra Postgres reales: lecturas, escrituras, TLS y caducidad contra una base desechable) y escaneo de dependencias. El 2026-11-11 se volvieron a correr las de integración (salvo las de TLS, que necesitan certificado) contra un PostgreSQL 17.5 desechable creado con `initdb` en una carpeta temporal.
- Interfaz: 95 pruebas (70 con backend simulado y 25 de la lógica pura: sentencias, parámetros, plan, CSV/JSON, comparación, JOIN por FK).
- Aplicación real (2026-11-11), con una configuración y un perfil de WebView aislados y la base desechable: Ctrl+N, salto por clave foránea en ambos sentidos, estructura y DDL, rejilla virtualizada (desplazamiento exacto y sin huecos con 200 filas cargadas), sentencia bajo el cursor, parámetros, plan con ANALYZE, JOIN sugerido por FK, buscar y reemplazar, vista de fila editando hasta aplicar en la base, comparación, y los comandos de importación y de archivos a través del puente real de Tauri (ensayo, importación, rechazo atómico de un duplicado). Los diálogos nativos de abrir y guardar no se pudieron automatizar: su lógica de rutas está probada con pruebas unitarias y no se vio el diálogo en pantalla.
- Aplicación real: migración de credenciales, conexión TLS verificada, edición con aplicación real y comprobación en la base, confirmación de producción, rechazo del servidor ante intentos de saltársela, capturas de ambos temas y sondas de la CSP.
