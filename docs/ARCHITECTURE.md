# Architecture

```
React (src/)  ──invoke──▶  Tauri commands (src-tauri/src/commands.rs)
                                   │
                    ┌──────────────┼───────────────┐
                    ▼              ▼               ▼
                 db.rs        profiles.rs      models.rs
          (tokio-postgres)   (profiles.json)   (serde DTOs)
```

- `db.rs`: all the logic against Postgres, with no dependency on Tauri (testable on its own).
- `commands.rs`: thin layer; keeps `Sessions` (map of connection id → `Arc<Client>`).
- `profiles.rs`: atomic read/write (temporary file + rename) of the saved connections.
- UI: `App` (tabs and global state), `Sidebar` (tree with a per-connection cache), `TableTab`, `SqlTab`, `ResultGrid`, `ConnectionDialog`.

## Decisions and trade-offs

**Simple protocol (`simple_query`) for data.** It returns every value as text, supports several statements and does not require knowing the types. It avoids writing a converter for every Postgres type (numeric, arrays, jsonb, ranges, geometric…). Cost: no types in the UI (numbers cannot be right-aligned or sorted on the client) and no bound parameters, so identifiers are escaped with `quote_ident` (doubled double quotes). Metadata queries do use parameterized statements.

**`tokio-postgres` instead of `sqlx`.** `sqlx` checks types at compile time but assumes a known schema; here the schema is arbitrary at run time, so `tokio-postgres` is more direct and lighter.

**One session per (connection, database).** Postgres does not allow switching database inside a session, so every database opened in the tree is its own TCP connection, created on click and closed when the server is disconnected. The session key is `<profileId>::<database>`. One `Client` per session, shared across tabs; queries are multiplexed over the same connection (they are serialized). Simple; no pool. A long query blocks the others on that connection until it is cancelled.

**Read-only mode with `default_transaction_read_only`.** It is applied with `SET` when the session opens (not as a startup option, so it works behind pgbouncer). Postgres itself rejects INSERT/UPDATE/DELETE/DDL with SQLSTATE 25006 and Hyrax adds an explanation. It is a guardrail against mistakes, not a security boundary: the user can turn it off with SQL. Enabling write mode needs explicit confirmation and goes back to read-only with one click. New connections are read-only by default.

**Streaming with a cap.** `simple_query_raw` delivers a stream: 1,000 rows are kept, counting continues up to 100,000 and then the query is cancelled on the server. Memory is bounded at the price of the total being a lower bound ("100,000+"). Rejected alternative: server cursors (`DECLARE`/`FETCH`), which require splitting the script into statements.

**Cancellation and timeout.** Each session keeps its `CancelToken`; cancelling opens an auxiliary connection (with TLS if the session uses it) and sends the cancel request. The timeout is the session's `statement_timeout`, set before every execution (60 s by default in the editor, configurable). Limitation: the cancel request targets whatever is running on that backend at that moment; if it arrives late it can affect the next query.

**CodeMirror 6 editor.** Chosen over Monaco for size and because the PostgreSQL dialect and schema-based autocomplete already come in `@codemirror/lang-sql`. The schema (tables and columns of all non-system schemas, capped at 3,000 tables) is requested once per tab with a single query to `pg_attribute` and injected by reconfiguring the language. The theme uses CSS variables, so it follows the light/dark theme without reloading.

**Explain and Analyze.** `EXPLAIN` does not run the query and is always available. `EXPLAIN ANALYZE` does run it (an `UPDATE` would be applied), so the button is only enabled in read-only mode, where Postgres rejects writes.

**History in `localStorage`, per server.** It is a per-machine convenience, not critical data: it can be lost when the embedded browser's data is cleared. It is deduplicated by text and limited to 100 entries. Queries that contain passwords in the SQL would be stored in plain text, as in any SQL client's history.

**Formatting with `sql-formatter`.** PostgreSQL dialect, uppercase keywords. If parsing fails the error is shown and the text is left untouched.

**Server-side filters with escaped literals.** `simple_query` does not accept parameters, so values are inserted as literals: doubled single quotes and, if there are backslashes, the `E'...'` form with the backslash doubled (correct with any value of `standard_conforming_strings`); column names go through `quote_ident`; the NUL character is rejected. `contains` and `starts with` use `column::text ILIKE` escaping `%`, `_` and `\`; comparisons (`=`, `>`, …) are typed, so `>5` on an integer compares numbers and `>2026-01-01` on a date compares dates (if the value is not valid for the type, Postgres returns its error). A free WHERE box was rejected: with multi-statement it would allow running arbitrary statements from the table view.

**Streamed export.** The server sends the rows and Hyrax writes them straight to the file without accumulating them in memory, so a table of millions of rows can be exported. Before starting, a `prepare` validates that it is a single statement that returns rows and learns the column types: that way the JSON carries real numbers and booleans (`2.50` is kept as is) and JSON/JSONB is embedded as a structure. If it fails or is cancelled, the partial file is deleted. CSV with a BOM because Excel needs it to read UTF-8; NULL comes out as an empty cell (CSV cannot tell NULL from an empty string). The destination is chosen by the user with the native dialog (`tauri-plugin-dialog`, `dialog:allow-save` permission).

**Estimated count + exact on demand.** `count(*)` is O(n) in Postgres; `reltuples` is shown (instant, approximate, `-1` if never analyzed) and a button gives the exact count.

**Pagination with `LIMIT/OFFSET`.** Simple and enough; it degrades with very large offsets. Future alternative: keyset pagination using the PK.

**Passwords in the system store.** `profiles.json` stores only host, port, database, user and options; the password lives in the Credential Manager (`keyring` crate, service `hyrax`, one entry per connection). The webview never receives it: `list_profiles` returns a `hasPassword` flag and the edit dialog does not preload it (empty = keep). Old connections with the password in the file are migrated automatically, and each password is re-read from the store before it is removed from the file. Trade-off: anyone who controls your Windows session can read the store (the usual trust boundary) and, if the store is unavailable, you cannot connect rather than falling back to plain text.

**TLS with `native-tls` (SChannel on Windows).** No OpenSSL or external native dependencies. Three modes: no TLS, `require` (encrypts without verifying, like libpq's `sslmode=require`, with a warning in the UI) and `verify` (validates the chain and the host name against the system roots or against your own PEM). Cancellation opens a second connection and uses the same mode. Tested against a server with a self-signed certificate.

**Tauri over Electron.** Small binary and a native Rust backend; cost: dependency on WebView2 and a Rust learning curve in the data layer.

## Data editing

**Pending changes and one transaction on apply.** Editing does not touch the database: modified cells, new rows and deleted rows accumulate in the UI (keyed by primary key value, so they survive changing page or order). On apply, the backend opens a transaction, runs each statement and commits only if every one affected exactly one row. The rejected alternative, a transaction kept open while editing, holds locks on production for minutes and is lost if the connection drops.

**The backend does not trust the client.** It receives column names and values; it looks up the column types and the primary key itself in the catalog. Values are bound as text parameters and converted with `$n::text::type`, which goes through the type's input function (works for numeric with precision, dates, jsonb, arrays and enums). Views, foreign tables, system tables and tables without a primary key are rejected; the primary key of an existing row is not edited.

**Concurrent-change detection.** Each `UPDATE` includes `ROW(col)::text IS NOT DISTINCT FROM ROW($n::text::type)::text` with the original value the user saw. The comparison uses the record's output representation rather than `col::text` because the two can differ (a boolean comes out as `t` when read but `true` with `::text`), which made untouched rows fail: a test against real Postgres uncovered it. If the row changed, everything is cancelled and explained.

**Order by primary key by default.** An `UPDATE` physically moves the row in Postgres; without `ORDER BY` the edited row jumped position after reloading. If the user did not choose an order and the table has a primary key, it is ordered by it (with the index it costs no more). Found while using the real application.

**Per-session lock.** Each session has an `RwLock`: reads share it, while applied changes and the ROLLBACK dry run take it exclusively, so no other tab interleaves queries inside an open transaction. Cancellation and mode switching do not use it, so a long query can be interrupted.

**ROLLBACK dry run.** It runs the script inside `BEGIN … ROLLBACK` and shows the result. It rejects scripts with `COMMIT`, `BEGIN`, `SAVEPOINT`… at the start of a statement (a `COMMIT` inside would commit the dry run) using a scanner that ignores comments, strings, quoted identifiers and `$$` blocks. Limitation: sequences advance, and effects outside the transaction (dblink, notifications) are not rolled back.

## Schema navigation (stage 9)

**One catalog pass per view, by `oid`.** `schema.rs` resolves the object once (`find_relation`) and then queries columns, indexes, constraints, FKs, triggers and statistics by `oid`. That avoids ambiguity between names with capitals or dots, and overloaded functions (same name, different arguments) are told apart by their `oid`, which travels from `search_objects` to `object_ddl`.

**DDL is built from the catalog, not with `pg_dump`.** `pg_get_constraintdef`, `pg_get_indexdef`, `pg_get_triggerdef`, `pg_get_viewdef` and `pg_get_functiondef` give the text of each piece; Hyrax only orders the parts (columns with identity, generated and collation; constraints with the FKs last; indexes that do not back a constraint; triggers; comments). A test against real Postgres runs the generated DDL in another schema and checks that the resulting structure is identical. What `pg_dump` does and this does not is left out: privileges, owners, storage options, types and domains.

**Structure and FKs in a single response.** `table_structure` also returns outgoing and incoming foreign keys (`referencedBy`), with their columns in order. The UI uses them to (a) draw a jump button in every cell of an FK column, which opens the target table filtered with `=` on all the key columns (composite keys too), and (b) offer "Referenced by…" on a selected row. If any key value is NULL, there is no navigation. The initial filters are passed exactly to the new tab, without going through the text of the filter row, so values like `null` or `>5` are not reinterpreted.

**Ctrl+N and Ctrl+Shift+A.** A single listener on `window` (capture phase, so it also works inside the editor). The object list is requested when the palette opens and filtered on the client with a subsequence match (`fuzzy.ts`); up to 20,000 objects.

## SQL console (stage 10)

**Statement under the cursor.** `statements.ts` splits the script on `;` using the same masking of strings, comments and `$$` blocks that the dangerous-statement warning already uses (`codeOnly`), and returns UTF-16 offsets (the ones CodeMirror uses; with emoji, code-point indexes would drift). Between two statements the earlier one wins. The active statement is marked with a side line. Ctrl+Enter runs the selection or that statement; Ctrl+Shift+Enter runs everything.

**`:name` parameters.** `params.ts` detects them outside strings and comments, discards casts (`::int`) and array slices, and replaces them with escaped literals using the same rule as the filters (doubled quotes and `E'…'` if there are backslashes; NUL rejected). The dangerous-statement warning and the server-side read-only filter are applied to the already-substituted text.

**Layered autocomplete.** `lang-sql` already resolves aliases and columns; Hyrax adds three sources through `EditorState.languageData`: snippets, functions (with the signature as detail) and JOIN. The JOIN suggestion (`joins.ts`) reads the tables in the current statement's `FROM`/`JOIN` and proposes the tables connected by FK in both directions with their `ON` (composite keys included) and an alias that does not collide with the existing ones. The FKs are requested once per tab (`completion_fks`).

**Plan as a tree.** Explain and Analyze request `EXPLAIN (FORMAT JSON)`. `plan.ts` computes each node's **own** cost (or time, with ANALYZE) by subtracting that of its children, and its share of the total; it marks the dominant node and row estimates that are off by 10× or more. If the text is not a JSON plan (for example, a hand-written `EXPLAIN` in another format) the text is shown as is.

**Scripts as files.** The open and save dialogs are opened from Rust, not from the UI: the window never chooses a path that is read, and it can only save again over a path the user chose in the dialog during this session (`ApprovedPaths`). That way the window's permissions are not widened.

## Advanced data (stage 11)

**Import in one transaction.** The UI reads and parses the file (CSV per RFC 4180 with separator detection, JSON as an array of objects, of arrays or NDJSON) and sends only the mapped columns. The backend revalidates against the catalog and runs a prepared `INSERT` with `$n::text::type` per row (the same technique as editing), pipelining 200 statements at a time over the connection so as not to pay a round trip per row. Everything runs between `BEGIN` and `COMMIT`; any error, with the row number, rolls everything back. "Dry run" does the same and ends in `ROLLBACK`. It takes the session's write lock.

**Comparing results.** `compare.ts` matches rows by the chosen key columns (or by the whole row if there is no key), distinguishes NULL from an empty string and warns about duplicate keys and truncated results. Pinned results live in the application's memory (maximum 8).

**Row view.** It is a form over the selected row with previous/next navigation. When editing it does not write to the database: it adds the modified fields to the stage 8 pending changes, so it keeps the SQL review and the atomic transaction. JSON is shown formatted and validated; arrays are shown as items and edited as `{…}` text.

**Virtualized grid.** With more than 150 rows only the visible ones plus a margin are drawn. To make that computable, rows are 25 px tall and each column's width is fixed once per result (from the content, capped at 440 px); without that, widths would jump while scrolling. Selection, copying and editing work on the real row indexes, not on the drawn rows.

## Language

**The original Spanish text is the translation key.** `t("Nueva conexión")` returns the same text in Spanish and its English translation in English (`src/i18n/en.ts`); `{name}` markers are replaced from the parameters. A text without a translation falls back to Spanish, so translating in stages never leaves a blank. The language lives in `localStorage` (`hyrax-lang`), defaults to **English**, and is changed in Settings; `useLang()` re-renders the app when it changes, with no reload. Module-level constants keep the Spanish text and are translated when drawn (never at import time), and the CodeMirror search panel is switched with a compartment so the editor keeps its text.

**Backend errors are translated on the front end.** Rust returns its messages in Spanish; `errorText()` passes them through `src/i18n/backend.ts`, a list of templates (`{}` marks a variable part such as a name or the server's own error, which is kept) applied only in English. A test reads the Rust sources and fails if a user-facing message has no translation, so a new message cannot ship untranslated. The erase confirmation word is `BORRAR` or `ERASE` according to the language, and the backend accepts both.

**Tests start in Spanish** (`src/test-setup.ts`); the English ones ask for it explicitly and check that no Spanish accent or `¿ ¡` is left on screen.

## SSH tunnel

**Local port forwarding with `russh`.** The tunnel listens on `127.0.0.1` on a random port and forwards to the Postgres host and port as seen from the SSH server. With verified TLS the certificate is still validated against the real host name (the connection goes to `127.0.0.1` through `hostaddr`, but `host` stays the real server). Authentication is a private key (decrypted outside the async threads) or a password.

**The server key is pinned, never accepted blindly.** The profile stores the SHA-256 fingerprint of the SSH server's host key. With no fingerprint saved the connection fails returning the fingerprint so the user can confirm it; if it later changes, it fails with a warning about a possible man-in-the-middle. After login, the tunnel checks right away that the server can forward to the target, to give the real reason when it cannot. The SSH secret goes to the system credential store (`ssh:<id>` entry), not to `profiles.json`.

## Saved data

Connections are stored in `profiles.json` in the user data folder and secrets in the system credential store. The old PgDesk profiles are copied only once (a `.legacy-checked` marker), so erased connections do not come back. "Erase saved connections and passwords" removes the file, every secret (including the old `pgdesk` service) and the old copy; if a credential cannot be deleted, the file is kept so it can be retried.

## Security

**Two-layer read-only.** `SET default_transaction_read_only = on` when connecting (with `SET`, not as a startup option, so it works behind pgbouncer) and a filter in Hyrax's backend that rejects statements that turn it off (`SET … read_only`, `BEGIN READ WRITE`, `set_config`, `RESET`, `DISCARD ALL`, `DO` containing those texts). It is a guardrail against slips: a real barrier needs an account without write permissions (see `SECURITY-REVIEW.md`).

**Production enforced on the server.** Each session knows whether its connection is marked as production; to switch to write mode the backend demands the exact database name, even if the command is called directly. The 10-minute write expiry is also applied on the server (when the session is used), and queries have a 5-minute cap.

**Strict CSP** (`default-src 'self'`, `script-src 'self'`, no `unsafe-eval`, no external connections). Inline styles are allowed because React and CodeMirror need them. The development policy is looser only for the Vite server.

**Minimal window permissions.** Only `core:default` and the save dialog; no file system or network access from the UI. The export path is validated again in the backend.

**Testing the real application.** It is started with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` and driven through the debugging protocol (screenshots, clicks, console). It is a test environment variable, not an application option.
