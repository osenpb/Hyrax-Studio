# Arquitectura

```
React (src/)  ──invoke──▶  Tauri commands (src-tauri/src/commands.rs)
                                   │
                    ┌──────────────┼───────────────┐
                    ▼              ▼               ▼
                 db.rs        profiles.rs      models.rs
          (tokio-postgres)   (profiles.json)   (DTOs serde)
```

- `db.rs`: toda la lógica contra Postgres, sin dependencia de Tauri (testeable sola).
- `commands.rs`: capa fina; mantiene `Sessions` (mapa id de conexión → `Arc<Client>`).
- `profiles.rs`: lectura/escritura atómica (archivo temporal + rename) de las conexiones guardadas.
- UI: `App` (pestañas y estado global), `Sidebar` (árbol con caché por conexión), `TableTab`, `SqlTab`, `ResultGrid`, `ConnectionDialog`.

## Decisiones y trade-offs

**Protocolo simple (`simple_query`) para datos.** Devuelve cada valor como texto, soporta varios statements y no exige conocer los tipos. Se evita escribir un conversor para cada tipo de Postgres (numeric, arrays, jsonb, rangos, geométricos…). Costo: sin tipos en la UI (no se puede alinear números ni ordenar en cliente) y sin parámetros enlazados, por lo que los identificadores se escapan con `quote_ident` (comillas dobles duplicadas). Los metadatos sí usan consultas parametrizadas.

**`tokio-postgres` en lugar de `sqlx`.** `sqlx` valida tipos en compilación pero asume esquema conocido; aquí el esquema es arbitrario en tiempo de ejecución, así que `tokio-postgres` es más directo y ligero.

**Una sesión por (conexión, base de datos).** Postgres no permite cambiar de base dentro de una sesión, así que cada base abierta en el árbol es una conexión TCP propia, creada al hacer clic y cerrada al desconectar el servidor. La clave de sesión es `<idPerfil>::<base>`. Un `Client` por sesión, compartido entre pestañas; las consultas se multiplexan sobre la misma conexión (se serializan). Simple; sin pool. Una consulta larga bloquea a las demás de esa conexión hasta la etapa de cancelación.

**Modo solo lectura con `default_transaction_read_only`.** Se aplica con `SET` al abrir la sesión (no como opción de arranque, para que funcione detrás de pgbouncer). Postgres mismo rechaza INSERT/UPDATE/DELETE/DDL con SQLSTATE 25006 y Hyrax añade una explicación. Es un guardarraíl contra errores, no una frontera de seguridad: el usuario puede desactivarlo con SQL. Habilitar escritura exige confirmación explícita y vuelve a solo lectura con un clic. Por defecto las conexiones nuevas son de solo lectura.

**Streaming con tope.** `simple_query_raw` entrega un stream: se guardan 1.000 filas, se siguen contando hasta 100.000 y entonces se cancela la consulta en el servidor. Memoria acotada a costa de que el total sea una cota inferior ("100.000+"). Alternativa descartada: cursores del servidor (`DECLARE`/`FETCH`), que exigen partir el script en sentencias.

**Cancelación y timeout.** Cada sesión guarda su `CancelToken`; cancelar abre una conexión auxiliar (con TLS si la sesión lo usa) y envía la petición de cancelación. El timeout es `statement_timeout` de la sesión, fijado antes de cada ejecución (60 s por defecto en el editor, configurable). Limitación: la petición de cancelación apunta a lo que corra en ese momento en el backend; si llega tarde puede afectar a la consulta siguiente.

**Editor CodeMirror 6.** Se eligió sobre Monaco por tamaño y porque el dialecto PostgreSQL y el autocompletado por esquema ya vienen en `@codemirror/lang-sql`. El esquema (tablas y columnas de todos los schemas no del sistema, tope 3000 tablas) se pide una vez por pestaña con una sola consulta a `pg_attribute`, y se inyecta reconfigurando el lenguaje. El tema usa variables CSS, así que sigue el tema claro/oscuro sin recargar.

**Explicar y Analizar.** `EXPLAIN` no ejecuta la consulta y siempre está disponible. `EXPLAIN ANALYZE` sí la ejecuta (un `UPDATE` se aplicaría), por eso el botón solo se habilita en modo solo lectura, donde Postgres rechaza las escrituras. El plan llega como filas de una columna `QUERY PLAN` y se muestra como texto.

**Historial en `localStorage`, por servidor.** Es una comodidad por equipo, no un dato crítico: puede perderse al limpiar datos del navegador embebido. Se deduplica por texto y se limita a 100 entradas. Las consultas con contraseñas en el SQL quedarían guardadas en claro, igual que en cualquier historial de cliente SQL.

**Formateo con `sql-formatter`.** Dialecto PostgreSQL, palabras clave en mayúsculas. Si falla el análisis se muestra el error y el texto no se toca.

**Filtros en el servidor con literales escapados.** `simple_query` no admite parámetros, así que los valores se insertan como literales: comillas simples duplicadas y, si hay barras invertidas, forma `E'...'` con la barra duplicada (correcto con cualquier valor de `standard_conforming_strings`); los nombres de columna pasan por `quote_ident`; el carácter NUL se rechaza. `contiene` y `empieza por` usan `columna::text ILIKE` escapando `%`, `_` y `\`; las comparaciones (`=`, `>`, …) son tipadas, así que `>5` sobre un entero compara números y `>2026-01-01` sobre una fecha compara fechas (si el valor no es válido para el tipo, Postgres devuelve su error). Se descartó una caja de WHERE libre: con multi-statement permitiría ejecutar sentencias arbitrarias desde la vista de tabla.

**Exportación en streaming.** El servidor envía las filas, y Hyrax las escribe directamente al archivo sin acumularlas en memoria, así que se puede exportar una tabla de millones de filas. Antes de empezar se hace un `prepare` para validar que es una sola sentencia que devuelve filas y para conocer los tipos de las columnas: así el JSON lleva números y booleanos reales (`2.50` se conserva tal cual) y el JSON/JSONB se incrusta como estructura. Si falla o se cancela, se borra el archivo parcial. CSV con BOM porque Excel lo necesita para leer UTF-8; NULL sale como celda vacía (el CSV no distingue NULL de cadena vacía). El destino lo elige el usuario con el diálogo nativo (`tauri-plugin-dialog`, permiso `dialog:allow-save`).

**Conteo estimado + exacto bajo demanda.** `count(*)` es O(n) en Postgres; se muestra `reltuples` (instantáneo, aproximado, `-1` si nunca se analizó) y un botón para el exacto.

**Paginación con `LIMIT/OFFSET`.** Sencilla y suficiente; degrada en offsets muy grandes. Alternativa futura: paginación por keyset usando la PK.

**Contraseñas en el almacén del sistema.** `profiles.json` guarda solo host, puerto, base, usuario y opciones; la contraseña vive en el Administrador de credenciales (crate `keyring`, servicio `hyrax`, una entrada por conexión). El webview nunca la recibe: `list_profiles` devuelve un indicador `hasPassword` y el diálogo de edición no la precarga (vacío = conservar). Las conexiones antiguas con la contraseña en el archivo se migran solas, y cada contraseña se relee del almacén antes de borrarla del archivo. Tradeoff: quien controle tu sesión de Windows puede leer el almacén (el límite de confianza habitual) y, si el almacén no está disponible, no se puede conectar en vez de caer a texto plano.

**TLS con `native-tls` (SChannel en Windows).** Sin OpenSSL ni dependencias nativas externas. Tres modos: sin TLS, `require` (cifra sin verificar, como `sslmode=require` de libpq, con aviso en la interfaz) y `verify` (valida la cadena y el nombre de host contra las entidades del sistema o contra un PEM propio). La cancelación abre una segunda conexión y usa el mismo modo. Probado contra un servidor con certificado autofirmado.

**Tauri sobre Electron.** Binario pequeño y backend nativo en Rust; costo: dependencia de WebView2 y curva de Rust en la capa de datos.

## Edición de datos

**Cambios pendientes y una transacción al aplicar.** Editar no toca la base: las celdas modificadas, las filas nuevas y las eliminadas se acumulan en la interfaz (clave por valor de clave primaria, así que sobreviven a cambiar de página u orden). Al aplicar, el backend abre una transacción, ejecuta cada sentencia y confirma solo si todas afectaron exactamente una fila. La alternativa descartada, una transacción abierta mientras se edita, mantiene bloqueos sobre producción durante minutos y se pierde si cae la conexión.

**El backend no confía en el cliente.** Recibe nombres de columna y valores; los tipos de columna y la clave primaria los consulta él en el catálogo. Los valores se enlazan como parámetros de texto y se convierten con `$n::text::tipo`, que pasa por la función de entrada del tipo (sirve para numeric con precisión, fechas, jsonb, arreglos y enums). Se rechazan vistas, tablas foráneas, tablas de sistema y tablas sin clave primaria; la clave primaria de una fila existente no se edita.

**Control de cambios concurrentes.** Cada `UPDATE` incluye `ROW(col)::text IS NOT DISTINCT FROM ROW($n::text::tipo)::text` con el valor original que vio el usuario. Se compara por la representación de salida del registro y no por `col::text` porque ambas pueden diferir (un booleano sale como `t` en la lectura pero `true` con `::text`), lo que hacía fallar filas sin tocar: lo descubrió una prueba contra Postgres real. Si la fila cambió, se cancela todo y se explica.

**Orden por clave primaria por defecto.** Un `UPDATE` mueve físicamente la fila en Postgres; sin `ORDER BY` la fila editada saltaba de posición tras recargar. Si el usuario no eligió un orden y la tabla tiene clave primaria, se ordena por ella (con el índice no cuesta más). Se descubrió usando la aplicación real.

**Cerrojo por sesión.** Cada sesión tiene un `RwLock`: las lecturas lo comparten y los cambios aplicados y el ensayo con ROLLBACK lo toman en exclusiva, para que ninguna otra pestaña intercale consultas dentro de una transacción abierta. La cancelación y el cambio de modo no lo usan, para poder interrumpir una consulta larga.

**Ensayo con ROLLBACK.** Ejecuta el script dentro de `BEGIN … ROLLBACK` y muestra el resultado. Rechaza scripts con `COMMIT`, `BEGIN`, `SAVEPOINT`… al inicio de una sentencia (un `COMMIT` dentro confirmaría el ensayo) usando un escáner que ignora comentarios, cadenas, identificadores entre comillas y bloques `$$`. Limitación: las secuencias avanzan, y los efectos fuera de la transacción (dblink, notificaciones) no se revierten.

## Navegación del esquema (etapa 9)

**Una pasada de catálogo por vista, con `oid`.** `schema.rs` resuelve el objeto una vez (`find_relation`) y luego consulta columnas, índices, constraints, FKs, triggers y estadísticas por `oid`. Así no hay ambigüedad entre nombres con mayúsculas o puntos, y las funciones sobrecargadas (mismo nombre, distintos argumentos) se distinguen por su `oid`, que viaja desde `search_objects` hasta `object_ddl`.

**El DDL se arma desde el catálogo, no con `pg_dump`.** `pg_get_constraintdef`, `pg_get_indexdef`, `pg_get_triggerdef`, `pg_get_viewdef` y `pg_get_functiondef` dan el texto de cada pieza; Hyrax solo ordena las partes (columnas con identidad, generadas y collation; constraints con las FK al final; índices que no respaldan una constraint; triggers; comentarios). Una prueba contra Postgres real ejecuta el DDL generado en otro schema y comprueba que la estructura resultante es idéntica. Queda fuera lo que `pg_dump` hace y aquí no: privilegios, dueños, opciones de almacenamiento, tipos y dominios.

**Estructura y FKs en una sola respuesta.** `table_structure` devuelve también las claves foráneas salientes y las entrantes (`referencedBy`), con sus columnas en orden. La interfaz las usa para (a) dibujar un botón de salto en cada celda de una columna FK, que abre la tabla destino filtrada con `=` por todas las columnas de la clave (también compuestas), y (b) ofrecer «Referenciada por…» sobre una fila seleccionada. Si algún valor de la clave es NULL, no se navega. Los filtros iniciales se pasan exactos a la pestaña nueva, sin pasar por el texto de la fila de filtros, para no reinterpretar valores como `null` o `>5`.

**Ctrl+N y Ctrl+Mayús+A.** Un único escuchador en `window` (fase de captura, para funcionar también dentro del editor). La lista de objetos se pide al abrir la paleta y se filtra en el cliente con una coincidencia por subsecuencia (`fuzzy.ts`); hasta 20.000 objetos.

## Consola SQL (etapa 10)

**Sentencia bajo el cursor.** `statements.ts` parte el script por `;` usando el mismo enmascarado de cadenas, comentarios y bloques `$$` que ya usa el aviso de sentencias peligrosas (`codeOnly`), y devuelve desplazamientos UTF-16 (los que usa CodeMirror; con emojis los índices por punto de código se desfasarían). Entre dos sentencias gana la anterior. La sentencia activa se marca con una línea lateral. Ctrl+Enter ejecuta la selección o esa sentencia; Ctrl+Mayús+Enter ejecuta todo.

**Parámetros `:nombre`.** `params.ts` los detecta fuera de cadenas y comentarios, descarta los casts (`::int`) y los cortes de arreglo, y los sustituye por literales escapados con la misma regla que los filtros (comillas duplicadas y `E'…'` si hay barras; NUL rechazado). El aviso de sentencias peligrosas y el filtro de solo lectura del servidor se aplican al texto ya sustituido.

**Autocompletado en capas.** `lang-sql` ya resuelve alias y columnas; Hyrax añade tres fuentes por `EditorState.languageData`: plantillas, funciones (con la firma como detalle) y JOIN. La sugerencia de JOIN (`joins.ts`) lee las tablas de `FROM`/`JOIN` de la sentencia actual y propone las tablas conectadas por FK en ambos sentidos con su `ON` (claves compuestas incluidas) y un alias que no choca con los existentes. Las FK se piden una vez por pestaña (`completion_fks`).

**Plan en árbol.** Explicar y Analizar piden `EXPLAIN (FORMAT JSON)`. `plan.ts` calcula el costo (o el tiempo, con ANALYZE) **propio** de cada nodo, restando el de sus hijos, y su parte del total; marca el nodo dominante y las estimaciones de filas que se desvían 10× o más. Si el texto no es un plan JSON (por ejemplo, un `EXPLAIN` escrito a mano en otro formato) se muestra el texto tal cual.

**Scripts como archivos.** Los diálogos de abrir y guardar se abren desde Rust, no desde la interfaz: la ventana nunca elige una ruta que se lea, y solo puede volver a guardar sobre una ruta que el usuario eligió en el diálogo durante esta sesión (`ApprovedPaths`). Así no se amplían los permisos de la ventana.

## Datos avanzados (etapa 11)

**Importación en una transacción.** La interfaz lee y analiza el archivo (CSV según RFC 4180 con detección de separador, JSON como arreglo de objetos, de arreglos o NDJSON) y envía solo las columnas asignadas. El backend revalida contra el catálogo y ejecuta un `INSERT` preparado con `$n::text::tipo` por fila (la misma técnica de la edición), encadenando 200 sentencias a la vez sobre la conexión para no pagar una ida y vuelta por fila. Todo va entre `BEGIN` y `COMMIT`; cualquier error, con el número de fila, revierte todo. «Ensayar» hace lo mismo y termina en `ROLLBACK`. Toma el cerrojo de escritura de la sesión.

**Comparar resultados.** `compare.ts` empareja filas por las columnas clave elegidas (o por la fila completa si no hay clave), distingue NULL de cadena vacía y avisa de claves repetidas y de resultados truncados. Los resultados fijados viven en memoria de la aplicación (máximo 8).

**Vista de fila.** Es un formulario sobre la fila seleccionada con navegación anterior/siguiente. Al editar no escribe en la base: añade los campos modificados a los cambios pendientes de la etapa 8, así que conserva la revisión del SQL y la transacción atómica. El JSON se muestra con formato y se valida; los arreglos se muestran como elementos y se editan como texto `{…}`.

**Rejilla virtualizada.** Con más de 150 filas solo se dibujan las visibles más un margen. Para poder calcularlo, las filas miden 25 px y el ancho de cada columna se fija una vez por resultado (a partir del contenido, con tope de 440 px); sin eso, los anchos saltarían al desplazarse. La selección, el copiado y la edición trabajan sobre los índices de fila reales, no sobre las filas dibujadas.

## Seguridad

**Solo lectura de dos capas.** `SET default_transaction_read_only = on` al conectar (con `SET`, no como opción de arranque, para que funcione detrás de pgbouncer) y un filtro en el servidor de Hyrax que rechaza las sentencias que lo desactivan (`SET … read_only`, `BEGIN READ WRITE`, `set_config`, `RESET`, `DISCARD ALL`, `DO` con esos textos). Es un guardarraíl contra descuidos: para una barrera real hace falta una cuenta sin permisos de escritura (ver `SEGURIDAD.md`).

**Producción impuesta en el servidor.** Cada sesión conoce si su conexión está marcada como producción; para pasar a escritura el backend exige el nombre exacto de la base, aunque se llame al comando directamente. La caducidad de 10 minutos de la escritura también se aplica en el servidor (al usar la sesión), y las consultas tienen un tope de 5 minutos.

**CSP estricta** (`default-src 'self'`, `script-src 'self'`, sin `unsafe-eval`, sin conexiones externas). Los estilos en línea se permiten porque React y CodeMirror los necesitan. La política de desarrollo es más laxa solo para el servidor de Vite.

**Permisos mínimos de la ventana.** Solo `core:default` y el diálogo de guardar; sin acceso al sistema de archivos ni a la red desde la interfaz. La ruta de exportación se valida otra vez en el backend.

**Probar la aplicación real.** Se arranca con `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` y se maneja por el protocolo de depuración (capturas, clics, consola). Es una variable de entorno de la prueba, no una opción de la aplicación.
