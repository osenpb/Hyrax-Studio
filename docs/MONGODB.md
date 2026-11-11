# Plan: soporte para MongoDB

Estado: **planificación** (2026-11-11). No hay código de MongoDB todavía. Este documento fija el alcance, las decisiones técnicas propuestas, las fases y los riesgos, para decidir antes de escribir código.

Meta: que Hyrax Studio pueda conectarse a MongoDB y cubra lo esencial del día a día (explorar, consultar, revisar y corregir documentos) con las mismas reglas de seguridad que ya tiene para PostgreSQL: solo lectura por defecto, producción marcada con confirmación, credenciales en el almacén del sistema y SQL (aquí, la operación) visible antes de aplicar.

## 1. Pantalla de inicio

Hoy, sin pestañas abiertas, se ve una bienvenida fija. Pasa a ser un **menú de inicio**:

- Dos tarjetas para crear una conexión: **PostgreSQL** y **MongoDB** (cada una abre el formulario de su motor).
- Lista de **conexiones recientes y guardadas**, con la insignia del motor (PG / Mongo) y la marca de producción.
- Acciones rápidas: pegar una cadena de conexión (`postgresql://…`, `mongodb://…`, `mongodb+srv://…`: el motor se deduce del esquema), abrir un script, ver atajos.
- El árbol de la izquierda sigue siendo la navegación principal; el inicio solo aparece cuando no hay pestañas.

Cambios que implica: el perfil de conexión gana un campo `engine` (`postgres` por defecto para los perfiles existentes) y el formulario de conexión pasa a ser un formulario por motor.

## 2. Qué es "lo esencial" en MongoDB

| Prioridad | Función | Notas |
|---|---|---|
| Imprescindible | Conectar (host/puerto o `mongodb+srv`, usuario, base de autenticación, TLS con CA opcional) | Contraseña en el almacén del sistema, igual que PG |
| Imprescindible | Árbol: servidor → bases → colecciones (y vistas) | Con conteo estimado y tamaño |
| Imprescindible | Ver documentos de una colección: paginación, filtro, orden, proyección | Filtro en JSON; cuadrícula con las claves de primer nivel y visor de documento completo |
| Imprescindible | Visor de documento: árbol JSON con tipos BSON visibles (ObjectId, Date, Decimal128, Binary…) | Se muestra JSON extendido, no se pierde el tipo |
| Imprescindible | Consola de consultas: `find` y `aggregate` con resultados | JSON, no JavaScript (ver 4.3) |
| Imprescindible | Solo lectura por defecto + producción marcada | Ver sección 5: aquí el "solo lectura" es más débil que en PG |
| Importante | Índices (lista, tamaño, uso) y estadísticas de la colección | `listIndexes`, `$collStats` |
| Importante | Esquema inferido por muestreo (`$sample`): claves, tipos y frecuencia | Sustituye al "DDL" de SQL |
| Importante | `explain` con etapa ganadora, documentos examinados vs devueltos | Árbol parecido al plan de PG |
| Importante | Exportar a JSON, NDJSON y CSV; copiar como `mongosh` | Streaming con tope, como PG |
| Importante | Insertar, editar y eliminar documentos, con vista previa y confirmación | Escritura con la misma ventana que caduca |
| Importante | Importar NDJSON/JSON/CSV | Con ensayo (conteo) antes de aplicar |
| Importante | Eliminar colección o base con confirmación escrita | Reutiliza `DropDialog` |
| Después | Crear/borrar índices, validadores de esquema, vistas | |
| Después | Túnel SSH hacia Mongo, autenticación X.509 / AWS / Kerberos, change streams | |
| No ahora | Editor de agregaciones visual, comparación de colecciones, GridFS | |

## 3. Qué se reutiliza y qué no

**Se reutiliza tal cual:** almacén de credenciales, perfiles guardados, formulario de conexión (con secciones por motor), túnel SSH (con salvedades, ver riesgos), paleta de comandos, menú contextual, diálogo de borrado con nombre escrito, borrado de datos guardados, historial, exportación en streaming, temas y tipografías, `CompareDialog` para resultados fijados.

**Hay que escribirlo de nuevo para Mongo:** el módulo de datos (driver, sesión, consultas), el visor de documentos, la consola (editor JSON en lugar de SQL), el plan de `explain`, el esquema por muestreo y la edición de documentos.

**No aplica:** SQL, DDL, claves foráneas navegables, estructura de tablas, parámetros `:nombre`, `ROLLBACK`.

## 4. Decisiones técnicas propuestas

### 4.1 Driver y tipos
- Driver oficial `mongodb` (asíncrono, sobre Tokio, que ya usamos) y `bson`. Versiones vigentes al planificar: `mongodb 3.x`, `bson 3.x`.
- Los valores viajan a la interfaz como **JSON extendido** (relajado para mostrar, canónico para editar), así no se pierden tipos como `Decimal128`, `Long` o `ObjectId`.
- **Spike previo (M0):** comprobar que compila en Windows sin herramientas extra (algunas dependencias criptográficas exigen CMake/NASM), medir cuánto crece el binario y pasar `cargo audit`. Si el driver oficial no encaja, se evalúa otra ruta antes de seguir.

### 4.2 Arquitectura del código
- Perfil: `engine: postgres | mongodb`, y para Mongo campos propios (hosts, `srv`, base de autenticación, conjunto de réplicas, TLS, lectura preferida). La URI se construye al conectar; **la contraseña nunca va en la URI guardada**.
- Backend: carpeta `src-tauri/src/mongo/` con `session`, `browse`, `schema`, `edit`, `import_export`. Comandos con prefijo `mongo_` para no tocar los de PostgreSQL. No se fuerza una abstracción común antes de tiempo: se extrae solo lo que de verdad coincida (perfiles, sesiones, errores, límites) cuando haya dos implementaciones.
- Sesiones: una conexión por perfil (el driver ya agrupa conexiones); la clave de sesión incluye el motor para no mezclarlas con las de PG.
- Interfaz: `Tab` gana tipos `collection`, `mongo-query` y `indexes`; el árbol de la barra lateral se alimenta por motor. Se evita que los componentes de SQL conozcan Mongo y viceversa.

### 4.3 Consola: JSON, no JavaScript
- Fase 1: pestañas de **Find** (filtro, proyección, orden, límite) y **Aggregate** (pipeline como arreglo JSON), con editor CodeMirror en modo JSON y autocompletado de campos tomados del muestreo.
- Una sintaxis tipo `db.coleccion.find({...}).sort({...})` se puede añadir después con un **analizador propio** de un subconjunto seguro. **No se ejecuta JavaScript** (ni `eval`, ni `$where`/`$function` por defecto): sería la forma más fácil de saltarse las protecciones.

### 4.4 Tiempos, cancelación y topes
- `maxTimeMS` como el tiempo máximo por consulta (mismos valores que PG, con tope menor en producción).
- Cancelar = cerrar el cursor y, si hace falta, `killOp`.
- Se cargan lotes con tope de documentos y de tamaño (un documento puede pesar hasta 16 MB); el conteo exacto es opcional, como en PG.

## 5. Seguridad: lo que cambia respecto a PostgreSQL

En PostgreSQL el modo solo lectura se apoya en `default_transaction_read_only`, una opción del propio servidor. **MongoDB no tiene un equivalente por sesión.** Por eso:

1. **La barrera real es el rol del usuario:** documentar y exigir en la guía una cuenta con rol `read`. Ejemplo para `docs/SEGURIDAD.md`: `db.createUser({user:"hyrax_ro", pwd:passwordPrompt(), roles:[{role:"read", db:"mi_base"}]})`.
2. **En la aplicación, el solo lectura es un guardarraíl:** la consola solo permite operaciones de lectura (`find`, `aggregate`, `count`, `distinct`, `explain`); las agregaciones se revisan y se **rechazan las etapas `$out` y `$merge`**, y `$function`/`$accumulator`/`$where` (JavaScript en el servidor). Todo comando que no esté en la lista se rechaza.
3. **Escritura:** misma ventana que caduca (10 minutos), confirmación escrita del nombre de la base en producción, validada también en el backend.
4. **No hay `ROLLBACK` gratuito:** las transacciones solo existen en conjuntos de réplicas y clústeres con particiones. El "ensayo" será una **vista previa**: cuántos documentos coinciden con el filtro y una muestra de ellos, antes de un `updateMany` o `deleteMany`. Si el servidor soporta transacciones, se puede ofrecer ensayo real como mejora.
5. **Control de cambios concurrentes al editar:** el filtro del `replaceOne`/`updateOne` incluye `_id` y el valor original de los campos modificados (o de todo el documento), para no pisar un cambio ajeno.
6. **Operaciones destructivas** (`drop`, `deleteMany` sin filtro, `updateMany` sin filtro): aviso reforzado y mostrar la operación exacta, como el SQL de PG.
7. Mismas reglas de credenciales: contraseña en el almacén del sistema, nunca en `profiles.json`, nunca en la URI guardada ni en el historial.

## 6. Fases

Cada fase termina con algo usable, pruebas automáticas y una revisión en la aplicación real. Tamaño relativo: S pequeño, M mediano, L grande.

**M0 — Fundamentos (M)**
- Spike del driver (compilación en Windows, tamaño, `cargo audit`).
- Campo `engine` en el perfil, con migración que deja `postgres` en los existentes.
- Pantalla de inicio con las dos tarjetas (la de Mongo detrás de un aviso hasta M1).
- Formulario de conexión por motor y detección del motor al pegar una cadena.
- Base de pruebas: `mongod` desechable y variables `HYRAX_MONGO_TEST_*` (ver sección 7).

**M1 — Conectar y explorar, solo lectura (L)** → *primer hito útil para tu uso*
- Conexión (hosts, SRV, usuario, base de autenticación, TLS con CA), probar y guardar.
- Árbol de bases y colecciones; conteo y tamaño.
- Pestaña de colección: paginación, filtro JSON, orden, proyección, visor de documento con tipos.
- Producción marcada, tiempo máximo y cancelar.
- Riesgo a vigilar: rendimiento con colecciones enormes y documentos grandes.

**M2 — Consulta y análisis (L)**
- Consola Find y Aggregate, historial, copiar como `mongosh`.
- Índices y estadísticas, esquema por muestreo, `explain` en árbol.
- Exportar a JSON, NDJSON y CSV.

**M3 — Escritura segura (L)**
- Insertar, editar y eliminar documentos con vista previa y control de concurrencia.
- Importar NDJSON/JSON/CSV con ensayo (conteo).
- Eliminar colección o base con confirmación; crear índice.

**M4 — Conexión avanzada y cierre (M)**
- Túnel SSH hacia Mongo, autenticación X.509/AWS si hace falta.
- Revisión de seguridad específica de Mongo, `cargo audit`, documentación y README al día, prueba del instalador.

Orden recomendado: M0 → M1 → M2 → M3 → M4, publicando cada una. M1 ya permite mirar una base real de forma segura.

## 7. Estrategia de pruebas

- **Unitarias** sin servidor: construcción de URI, validación de filtros y pipelines (rechazo de `$out`, `$merge`, JavaScript), conversión BSON ↔ JSON extendido, topes.
- **Integración** contra un **`mongod` desechable**: ya hay MongoDB Server 8.0 y `mongosh` instalados en tu equipo (`C:\Program Files\MongoDB`). Se arranca otra instancia con `--dbpath` en una carpeta temporal y un puerto distinto (por ejemplo 27018), y se borra al terminar. Para probar transacciones y `explain` realista hará falta un conjunto de réplicas de un solo nodo.
- **Regla fija:** el servicio de MongoDB que ya corre en tu equipo (puerto 27017) **no se usa para escribir**; solo lecturas y solo con tu permiso. Las pruebas de escritura exigirán que la base se llame `scratch`, como en PG, y variables `HYRAX_MONGO_TEST_*`.
- **Aplicación real** con el depurador de WebView2 y una identidad aislada (como se hizo con PG), incluida una conexión a través del túnel SSH cuando llegue M4.
- Pruebas de interfaz con el backend simulado, como las actuales.

## 8. Riesgos y puntos abiertos

| Riesgo | Mitigación |
|---|---|
| El driver oficial exige herramientas de compilación o infla el binario | Spike en M0 antes de comprometer el diseño |
| Falso sentido de seguridad del "solo lectura" | Decirlo en la interfaz y en `SEGURIDAD.md`; exigir rol `read` |
| Túnel SSH + conjuntos de réplicas: el driver descubre los nombres internos de los nodos y salta el túnel | Usar `directConnection=true` por el túnel; avisar de la limitación; verificar TLS contra el nombre real del servidor |
| Documentos enormes o colecciones de miles de millones | Topes de tamaño y de documentos, conteo estimado por defecto, nada de `skip` grande sin aviso |
| Tipos BSON que se pierden al editar | Editar siempre sobre JSON extendido canónico |
| Dependencias nuevas con avisos de seguridad | `cargo audit` en cada fase y registro en `SEGURIDAD.md` |
| Alcance: Mongo es un segundo producto dentro del primero | Fases con entregables; no abstraer en exceso antes de tener M1 funcionando |

## 9. Decisiones que necesito de ti

Propongo un valor por defecto para cada una; con tu respuesta se cierra M0.

1. **Consola:** ¿empezamos con JSON puro (Find/Aggregate) y dejamos la sintaxis `db.col.find()` para después? *Propuesto: sí.*
2. **Escritura en la primera versión de Mongo:** ¿M1 y M2 solo lectura y la escritura llega en M3? *Propuesto: sí, para poder usarlo ya con bases de empresa.*
3. **Tu Mongo real:** ¿dónde está (local, Atlas con `mongodb+srv`, servidor de la empresa), con qué autenticación y con TLS? Eso define qué conexión y qué prueba son prioritarias, y si el túnel SSH sube de prioridad.
4. **Pantalla de inicio:** ¿tarjetas grandes de motor más lista de recientes (como se describe arriba) o prefieres algo más sobrio, solo una lista con un botón «Nueva conexión» que pregunte el motor?
5. **Nombre de colección en la interfaz:** ¿"colección/documento" tal cual, o unificar términos con SQL ("tabla/fila") en lo que sea común?
