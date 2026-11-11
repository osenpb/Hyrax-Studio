# Roadmap por etapas

Estado: ✅ hecho · 🟡 parcial · ⬜ pendiente

## Etapa 0 — Fundamentos ✅
Estructura del proyecto, Tauri 2 + Vite + React, ícono, README, documentación.

## Etapa 1 — Conexión y metadatos (backend) ✅
Conexión a Postgres (con y sin TLS), listado de schemas, relaciones y columnas con PK. Test de integración contra servidor real.

## Etapa 2 — Navegador en árbol ✅
Árbol servidor → bases de datos → schemas → objetos → columnas (clic en una base abre su sesión), carga perezosa, grupos por tipo de objeto, columnas, filtro por nombre, redimensionado del panel.

## Etapa 3 — Visor de tabla ✅
Paginación, ordenación en servidor, conteo estimado/exacto, pestaña Estructura, inspector de celda.

## Etapa 4 — Editor SQL ✅
Ejecución de uno o varios statements, resultados múltiples, tiempos, errores detallados, límite de filas mostradas.

## Etapa 5 — Conexiones persistentes ✅ (🟡 seguridad)
Conexiones guardadas en `profiles.json` del directorio de configuración de la app. **Pendiente:** contraseña en el almacén del SO (Credential Manager) en lugar de texto plano.

## Etapa 5b — Seguridad y robustez ✅ (2026-11-10)
Modo solo lectura por conexión y por sesión (con confirmación para habilitar escritura), cancelación de consulta en curso, límite de tiempo por consulta, lectura en streaming con tope de 100.000 filas contadas y 1.000 mostradas. Rediseño visual: iconos SVG, tema claro/oscuro/automático, etiquetas de modo en el árbol.

## Etapa 6 — Productividad del editor ✅ (2026-11-10)
CodeMirror 6 con resaltado, números de línea y autocompletado de tablas y columnas del servidor, historial por servidor (100 consultas), formateo SQL (Mayús+Alt+F, respeta la selección), Explicar (`EXPLAIN`) y Analizar (`EXPLAIN ANALYZE`, solo en modo solo lectura) con el plan en texto.

**Pendiente de esta etapa:** scripts guardados con nombre, plan visual en árbol, autocompletado de funciones y de alias.

## Etapa 7 — Datos ✅ (2026-11-10)
Filtros por columna en el visor (fila de filtros con operadores: texto = contiene, `=x`, `!=x`, `>5`, `>=5`, `<5`, `<=5`, `^x` empieza por, `null`, `!null`), ejecutados en el servidor, con conteo exacto filtrado. Exportación a CSV (UTF-8 con BOM), JSON (con tipos) y SQL INSERT, desde el visor (tabla completa con filtros y orden actuales) y desde el editor SQL (la sentencia o selección), en streaming a archivo y cancelable.

**Pendiente de esta etapa:** ordenación múltiple, copiar filas al portapapeles, vista formateada de valores JSON largos.

## Etapa 8 — Edición de datos ⬜
Editar celdas, insertar y borrar filas por PK, transacciones explícitas (commit/rollback). El modo solo lectura ya existe (etapa 5b).

## Etapa 9 — Objetos de esquema ⬜
DDL de tablas, índices, constraints, FK navegables, triggers, secuencias, funciones, vistas; relaciones entre tablas (diagrama ER).

## Etapa 10 — Conexión avanzada y distribución ⬜
Túnel SSH, verificación de certificado con CA propia, `sslmode` completo, instalador firmado, actualizaciones automáticas.

## Limitaciones conocidas de la v0.1
- Todos los valores se muestran como texto (protocolo simple de Postgres); no hay tipos nativos en la grilla.
- Si un resultado supera 100.000 filas, PgDesk cancela la consulta en el servidor y muestra "100.000+"; las sentencias posteriores de un script multi-statement no se ejecutan.
- El modo solo lectura es un guardarraíl (`default_transaction_read_only`): quien escriba `SET default_transaction_read_only = off` o `BEGIN READ WRITE` puede saltarlo. Para una barrera real, conectar con un rol sin permisos de escritura.
- SSL "requerido" cifra pero no verifica el certificado.
