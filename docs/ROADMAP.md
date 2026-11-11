# Roadmap

Product goal: a database client with DataGrip's essential features but lightweight (small binary, instant startup, low memory) thanks to Rust and Tauri. Priority goes to what is used every day and to what prevents accidents in production.

Status: ✅ done · 🟡 partial · ⬜ pending

## Done

| Stage | Contents |
|---|---|
| 0 Foundations | Project structure, Tauri 2 + React, documentation |
| 1 Connection and metadata | Connection with and without TLS, schemas, tables, columns, primary keys |
| 2 Navigator | Server → databases → schemas → objects → columns tree, lazy loading, filter |
| 3 Table viewer | Pagination, sorting, counts, structure, cell inspector |
| 4 SQL editor | Multiple statements, results in tabs, detailed errors |
| 5 Connections | Saved, with the password in the system credential store |
| 5b Robustness | Read-only mode, cancel, time limit, streamed results with a cap |
| 6 Editor | CodeMirror, table and column autocomplete, history, formatting, Explain/Analyze |
| 7 Data | Per-column filters, multi-column sorting, export CSV/JSON/INSERT, copy rows, formatted JSON |
| 8 Editing | Cells, new and deleted rows as pending changes, SQL review, atomic apply with concurrency control |
| Security | Production marking, server-side confirmation, verified TLS, CSP, dangerous statements, dry run with ROLLBACK. See `SECURITY-REVIEW.md` |
| 9 Schema navigation | Ctrl+N (tables, views, materialized views, foreign tables, functions, procedures, sequences) and the Ctrl+Shift+A command palette; DDL for tables, views, functions and sequences; foreign keys navigable both ways; full Structure tab (columns, FKs, references, indexes, constraints, triggers, statistics and size) |
| 10 SQL console | Ctrl+Enter runs the statement at the cursor and Ctrl+Shift+Enter the whole script; `:name` parameters; autocomplete of aliases, JOIN suggested from FKs, functions with their signature and 17 snippets; open and save `.sql` scripts; find and replace; execution plan as a tree with the most expensive node highlighted; pinned results to compare |
| 11 Advanced data | Import CSV/TSV/JSON with column mapping, preview, ROLLBACK dry run and a single transaction; compare two pinned results; row view as a form with JSON editor, arrays and long text; editing with active filters; virtualized grid |

## Pending from stages 9 to 11

- 🟡 **Editing through updatable views.** Not done: a view has no primary key, so per-row concurrency control has nothing to rely on. It would need to resolve the base table and which view columns carry its key.
- 🟡 **Context-aware keywords** in autocomplete: today the PostgreSQL dialect keywords are offered without filtering by cursor position.
- 🟡 **Saved scripts**: they are opened and saved as `.sql` files wherever the user chooses (for example, inside a git repository), but there is no panel with a scripts folder. There are no user-defined snippets either.
- 🟡 **Comparing two tables**: the rows that are loaded are compared (a page of the table or the result of `SELECT * FROM …`, up to 5,000 rows), with a warning if the result is truncated. There is no full comparison of huge tables.
- 🟡 **Go to object** does not list indexes, constraints, triggers, types or domains as entries of their own; the first three are visible in the Structure tab and included in the table's DDL.

## Next

### Stage 12 — Diagrams and schema comparison
- ER diagram of a schema or of a table and its neighbours.
- Compare the schema of two databases and generate the difference script.
- Design review: warnings about bad practices (FK without index, tables without a primary key, unsuitable types…) using the same structure the Structure tab already exposes.

### Stage 13 — Operations
- Session and lock monitor (`pg_stat_activity`), with cancel or terminate a query.
- Table and index statistics, sizes, bloated tables.
- Roles, privileges and extensions.

### Stage 14 — Connection and distribution
- ✅ SSH tunnel (private key or password, server host key pinned to the connection) and `postgresql://…` connection strings.
- ⬜ SSH tunnel with `ssh-agent` and jump hosts; import connections from DBeaver and pgAdmin.
- 🟡 Installer (built unsigned); ⬜ code signing and automatic updates.
- Security review before every release.

## MongoDB (being planned)

- **MongoDB support**, with a start screen to choose the engine. It was decided (2026-11-11) to plan it now, in parallel with stages 12 to 14. Scope, decisions, phases (M0 to M4) and risks are in [MONGODB.md](MONGODB.md). The security rules stay: read-only by default, production marked with confirmation and credentials in the system store; in Mongo, read-only is a weaker guardrail (there is no per-session equivalent) and the real barrier is a user with the `read` role.

## Known limitations
- All values are shown as text (Postgres simple protocol); there are no native types in the grid.
- If a result exceeds 100,000 rows, Hyrax cancels the query on the server and shows "100,000+"; later statements of a script are not run. Up to 5,000 rows per result are kept on screen.
- Import supports up to 200,000 rows per file and 64 MB; the file must be UTF-8.
- `:name` parameters are substituted as escaped text literals (they are not bound protocol parameters); they are not detected inside strings, comments or `$$` blocks.
- Function signatures are shown in autocomplete, but their arguments are not filled in.
- The application's read-only mode is a guardrail, not a security barrier (see `SECURITY-REVIEW.md`).
- Requires PostgreSQL 11 or later for the function catalog (`prokind`) and partition foreign keys.
- Tested on Windows only.
