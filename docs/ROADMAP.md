# Hoja de ruta

Meta del producto: un cliente de PostgreSQL con las funciones esenciales de DataGrip, pero ligero (binario pequeño, arranque inmediato, poca memoria) gracias a Rust y Tauri. Se prioriza lo que se usa todos los días y lo que evita accidentes en producción.

Estado: ✅ hecho · 🟡 parcial · ⬜ pendiente

## Hecho

| Etapa | Contenido |
|---|---|
| 0 Fundamentos | Estructura del proyecto, Tauri 2 + React, documentación |
| 1 Conexión y metadatos | Conexión con y sin TLS, schemas, tablas, columnas, claves primarias |
| 2 Navegador | Árbol servidor → bases → schemas → objetos → columnas, carga perezosa, filtro |
| 3 Visor de tabla | Paginación, orden, conteos, estructura, inspector de celda |
| 4 Editor SQL | Varios statements, resultados en pestañas, errores detallados |
| 5 Conexiones | Guardadas, con la contraseña en el almacén del sistema |
| 5b Robustez | Solo lectura, cancelar, límite de tiempo, resultados en streaming con tope |
| 6 Editor | CodeMirror, autocompletado de tablas y columnas, historial, formato, Explicar/Analizar |
| 7 Datos | Filtros por columna, orden por varias columnas, exportar CSV/JSON/INSERT, copiar filas, JSON formateado |
| 8 Edición | Celdas, filas nuevas y eliminadas en cambios pendientes, revisión del SQL, aplicación atómica con control de concurrencia |
| Seguridad | Producción marcada, confirmación en el servidor, TLS verificado, CSP, sentencias peligrosas, ensayo con ROLLBACK. Ver `SEGURIDAD.md` |
| 9 Navegar el esquema | Ctrl+N (tablas, vistas, vistas materializadas, foráneas, funciones, procedimientos, secuencias) y paleta de comandos Ctrl+Mayús+A; DDL de tablas, vistas, funciones y secuencias; claves foráneas navegables en ambos sentidos; pestaña Estructura completa (columnas, FKs, referencias, índices, constraints, triggers, estadísticas y tamaño) |
| 10 Consola SQL | Ctrl+Enter ejecuta la sentencia del cursor y Ctrl+Mayús+Enter todo el script; parámetros `:nombre`; autocompletado de alias, JOIN sugerido por FK, funciones con su firma y 17 plantillas; abrir y guardar scripts `.sql`; buscar y reemplazar; plan de ejecución en árbol con el nodo más costoso resaltado; resultados fijados para comparar |
| 11 Datos avanzados | Importar CSV/TSV/JSON con asignación de columnas, vista previa, ensayo con ROLLBACK y una sola transacción; comparar dos resultados fijados; vista de fila como formulario con editor de JSON, arreglos y texto largo; edición con filtros activos; rejilla virtualizada |

## Pendiente de las etapas 9 a 11

- 🟡 **Edición sobre vistas actualizables.** No se hizo: una vista no tiene clave primaria, así que el control de concurrencia por fila no tiene en qué apoyarse. Habría que resolver la tabla base y qué columnas de la vista llevan su clave.
- 🟡 **Palabras clave según el contexto** en el autocompletado: hoy se ofrecen las del dialecto PostgreSQL sin filtrarlas por la posición del cursor.
- 🟡 **Scripts guardados**: se abren y guardan como archivos `.sql` donde el usuario elija (por ejemplo, dentro de un repositorio git), pero no hay un panel con una carpeta de scripts. Tampoco hay plantillas definidas por el usuario.
- 🟡 **Comparar dos tablas**: se comparan las filas que están cargadas (una página de la tabla o el resultado de `SELECT * FROM …`, hasta 5.000 filas), con aviso si el resultado está truncado. No hay una comparación completa de tablas enormes.
- 🟡 **Ir a objeto** no incluye índices, constraints, triggers, tipos ni dominios como entradas propias; los tres primeros se ven en la pestaña Estructura y van dentro del DDL de la tabla.

## Siguiente

### Etapa 12 — Diagramas y comparación de esquemas
- Diagrama ER de un schema o de una tabla y sus vecinas.
- Comparar el esquema de dos bases y generar el script de diferencias.
- Revisión de diseño: avisos sobre malas prácticas (FK sin índice, tablas sin clave primaria, tipos poco adecuados…) usando la misma estructura que ya expone la pestaña Estructura.

### Etapa 13 — Operación
- Monitor de sesiones y bloqueos (`pg_stat_activity`), con cancelar o terminar una consulta.
- Estadísticas de tablas e índices, tamaños, tablas hinchadas.
- Roles, privilegios y extensiones.

### Etapa 14 — Conexión y distribución
- ✅ Túnel SSH (clave privada o contraseña, huella del servidor fijada en la conexión) y cadenas de conexión `postgresql://…`.
- ⬜ Túnel SSH con `ssh-agent` y saltos; importar conexiones de DBeaver y pgAdmin.
- 🟡 Instalador (se genera sin firmar); ⬜ firma de código y actualizaciones automáticas.
- Revisión de seguridad antes de cada versión.

## Después de la versión para PostgreSQL

- Volver a este gestor para que también funcione con **MongoDB**. Se retoma solo cuando las etapas 12 a 14 estén terminadas. Habrá que decidir si se separa una capa común (conexiones, árbol, editor, exportación) con un adaptador por motor, porque gran parte de lo actual (SQL, edición por clave primaria, transacciones, `EXPLAIN`, DDL, importación) es específico de Postgres. Se mantienen las reglas de seguridad: solo lectura por defecto, producción marcada con confirmación y credenciales en el almacén del sistema.

## Limitaciones conocidas
- Todos los valores se muestran como texto (protocolo simple de Postgres); no hay tipos nativos en la rejilla.
- Si un resultado supera 100.000 filas, Hyrax cancela la consulta en el servidor y muestra "100.000+"; las sentencias posteriores de un script no se ejecutan. En pantalla se guardan hasta 5.000 filas por resultado.
- La importación admite hasta 200.000 filas por archivo y 64 MB; el archivo debe estar en UTF-8.
- Los parámetros `:nombre` se sustituyen como literales de texto escapados (no son parámetros enlazados del protocolo); no se detectan dentro de cadenas, comentarios ni bloques `$$`.
- Las firmas de las funciones se muestran en el autocompletado, pero no se rellenan los argumentos.
- El solo lectura de la aplicación es un guardarraíl, no una barrera de seguridad (ver `SEGURIDAD.md`).
- Requiere PostgreSQL 11 o superior para el catálogo de funciones (`prokind`) y claves foráneas de particiones.
- Solo probado en Windows.
