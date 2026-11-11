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

## Siguiente: lo esencial de DataGrip

### Etapa 9 — Navegar el esquema como en DataGrip
- Ir a cualquier tabla, vista o función por nombre con un atajo (Ctrl+N) y una paleta de comandos (Ctrl+Shift+A).
- Ver y copiar el DDL de tablas, vistas, índices, constraints, triggers y funciones.
- Claves foráneas navegables: de un valor al registro relacionado y, desde una tabla, ver quién la referencia.
- Pestaña de estructura completa: índices, constraints, FKs, triggers, estadísticas y tamaño.

### Etapa 10 — Consola SQL de nivel DataGrip
- Autocompletado de alias, columnas tras `JOIN` (sugiriendo la FK), funciones con su firma y palabras clave según el contexto.
- Varias consolas por conexión y scripts guardados con nombre, en archivos que se pueden abrir y versionar.
- Ejecutar la sentencia bajo el cursor, no todo el script; resultados que se pueden fijar para comparar.
- Parámetros con nombre (`:id`), plantillas (snippets), buscar y reemplazar.
- Plan de ejecución visual en árbol con los nodos más costosos resaltados.

### Etapa 11 — Datos avanzados
- Importar CSV/JSON a una tabla con asignación de columnas y vista previa, dentro de una transacción.
- Comparar dos resultados o dos tablas.
- Vista de fila como formulario, y editor de valores JSON, arreglos y texto largo.
- Edición con filtros activos y con vistas actualizables.
- Rejilla virtualizada para páginas muy grandes.

### Etapa 12 — Diagramas y comparación de esquemas
- Diagrama ER de un schema o de una tabla y sus vecinas.
- Comparar el esquema de dos bases y generar el script de diferencias.

### Etapa 13 — Operación
- Monitor de sesiones y bloqueos (`pg_stat_activity`), con cancelar o terminar una consulta.
- Estadísticas de tablas e índices, tamaños, tablas hinchadas.
- Roles, privilegios y extensiones.

### Etapa 14 — Conexión y distribución
- Túnel SSH, cadenas de conexión (`postgresql://…`), importar conexiones de DBeaver y pgAdmin.
- Instalador firmado y actualizaciones automáticas.
- Revisión de seguridad antes de cada versión.

## Limitaciones conocidas
- Todos los valores se muestran como texto (protocolo simple de Postgres); no hay tipos nativos en la rejilla.
- Si un resultado supera 100.000 filas, PgDesk cancela la consulta en el servidor y muestra "100.000+"; las sentencias posteriores de un script no se ejecutan.
- El solo lectura de la aplicación es un guardarraíl, no una barrera de seguridad (ver `SEGURIDAD.md`).
- Solo probado en Windows.
