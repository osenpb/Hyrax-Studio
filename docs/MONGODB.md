# Plan: MongoDB support

Status: **phases M0 and M1 done** (2026-11-11): MongoDB connections can be created, tested and explored read-only; query and analysis (M2) is next. This document fixes the scope, the technical decisions, the phases and the risks.

Goal: Hyrax Studio can connect to MongoDB and cover the everyday essentials (browse, query, review and fix documents) with the same safety rules it already has for PostgreSQL: read-only by default, production marked with confirmation, credentials in the system store, and the operation shown before it is applied.

## Decisions taken (2026-11-11)

| # | Question | Decision |
|---|---|---|
| 1 | Console style | **JSON (Find / Aggregate) first**, no `db.col.find()` syntax yet — *as long as the UI is comfortable to use*. That makes comfort a requirement, not an extra: field autocomplete from sampling, ready-made templates, formatting and validation as you type, a quick filter bar on the collection view (so simple filters need no JSON at all), and "copy as mongosh". |
| 2 | Writes | **Exploration first.** M1 and M2 are read-only; writing arrives in M3. |
| 3 | Real MongoDB targets | **Local, Atlas and a company server.** So `mongodb+srv://`, TLS and a custom CA file are part of M1, not a later phase. The SSH tunnel stays optional (Atlas does not need it). |
| 4 | Start screen | **Whatever performs best**: a plain, lightweight list of saved connections (engine badge, production mark), no heavy cards or images, rendered lazily. The engine choice lives in the "New connection" dialog. |
| 5 | Vocabulary | **MongoDB's own terms** in the MongoDB views: collection, document, field, aggregation pipeline, index. |

## 1. Start screen

Today, with no tabs open, a fixed welcome is shown. It becomes a **start menu**, kept deliberately simple and fast:

- A list of **saved connections** with an engine badge (PG / Mongo), the production mark and the last time it was used, plus a **New connection** button that first asks for the engine.
- Pasting a connection string (`postgresql://…`, `mongodb://…`, `mongodb+srv://…`) anywhere on the screen creates the connection and deduces the engine from the scheme.
- Quick actions: open a script, shortcuts.
- The tree on the left stays the main navigation; the start screen only shows when there are no tabs.

What it implies: the connection profile gains an `engine` field (`postgres` by default for existing profiles) and the connection form becomes one form per engine.

## 2. What "essential" means for MongoDB

| Priority | Feature | Notes |
|---|---|---|
| Must | Connect (host/port or `mongodb+srv`, user, auth database, TLS with an optional CA file) | Password in the system store, like PG |
| Must | Tree: server → databases → collections (and views) | With estimated count and size |
| Must | Browse a collection's documents: pagination, filter, sort, projection | Quick filter bar plus JSON filter; grid with top-level fields and a full document viewer |
| Must | Document viewer: JSON tree with BSON types visible (ObjectId, Date, Decimal128, Binary…) | Extended JSON is shown, types are not lost |
| Must | Query console: `find` and `aggregate` with results | JSON, not JavaScript (see 4.3) |
| Must | Read-only by default + production marking | See section 5: here read-only is weaker than in PG |
| Should | Indexes (list, size, usage) and collection statistics | `listIndexes`, `$collStats` |
| Should | Schema inferred by sampling (`$sample`): fields, types and frequency | Replaces SQL's "DDL" |
| Should | `explain` with winning stage, documents examined vs returned | Tree like PG's plan |
| Should | Export to JSON, NDJSON and CSV; copy as `mongosh` | Streamed with a cap, like PG |
| Should | Insert, edit and delete documents, with preview and confirmation | Write mode with the same expiring window |
| Should | Import NDJSON/JSON/CSV | With a dry run (count) before applying |
| Should | Drop a collection or database with typed confirmation | Reuses `DropDialog` |
| Later | Create/drop indexes, schema validators, views | |
| Later | SSH tunnel to Mongo, X.509 / AWS / Kerberos authentication, change streams | |
| Not now | Visual aggregation builder, collection comparison, GridFS | |

## 3. What is reused and what is not

**Reused as is:** credential store, saved profiles, connection form (with per-engine sections), SSH tunnel (with caveats, see risks), command palette, context menu, drop dialog with typed name, erase saved data, history, streamed export, themes and fonts, `CompareDialog` for pinned results.

**Must be written anew for Mongo:** the data module (driver, session, queries), the document viewer, the console (JSON editor instead of SQL), the `explain` plan view, schema by sampling and document editing.

**Does not apply:** SQL, DDL, navigable foreign keys, table structure, `:name` parameters, `ROLLBACK`.

## 4. Proposed technical decisions

### 4.1 Driver and types
- Official `mongodb` driver (async, on Tokio, which we already use) and `bson`. Versions current at planning time: `mongodb 3.x`, `bson 3.x`.
- Values travel to the UI as **Extended JSON** (relaxed for display, canonical for editing), so types like `Decimal128`, `Long` or `ObjectId` are not lost.

**Driver spike (done 2026-11-11, dependency now in use):**
- `mongodb 3` with `default-features = false` and `features = ["compat-3-3-0", "rustls-tls", "dns-resolver", "bson-3"]` **compiles on Windows** with no extra tools: it uses `rustls` with `ring`, and `aws-lc-sys` (which would need CMake and NASM) is not in the dependency tree. `dns-resolver` brings the SRV lookups Atlas needs.
- The driver requires `compat-3-3-0` to be enabled explicitly.
- **Two TLS stacks:** PostgreSQL uses `native-tls` (the Windows store), MongoDB would use `rustls`. `rustls-tls` ships bundled public roots (`webpki-roots`) and does **not** read the Windows certificate store, so a company server with a private CA needs its CA given as a PEM file (the same "custom CA" field PG already has). Atlas works with the bundled roots.
- **Binary size (release, measured):** 6.83 MB → 9.03 MB (+2.2 MB, +32%) with the driver linked and used. Accepted.
- **`cargo audit`:** the new dependencies add **no new notices**; the two that appear (`crypto-bigint`, `rsa`) come from `russh` and are unchanged.
- The release build with the driver took about 16 minutes on the development machine (single codegen unit + LTO), and a debug build with incremental compilation filled the disk (24 GB of cache): builds are now run with `CARGO_INCREMENTAL=0`.

### 4.2 Code architecture
- Profile: `engine: postgres | mongodb`, and for Mongo its own fields (hosts, `srv`, auth database, replica set, TLS, read preference). The URI is built when connecting; **the password is never part of the stored URI**.
- Backend: folder `src-tauri/src/mongo/` with `session`, `browse`, `schema`, `edit`, `import_export`. Commands prefixed `mongo_` so the PostgreSQL ones are untouched. No shared abstraction is forced ahead of time: only what really coincides (profiles, sessions, errors, limits) is extracted once there are two implementations.
- Sessions: one connection per profile (the driver already pools); the session key includes the engine so they are not mixed with PG's.
- UI: `Tab` gains kinds `collection`, `mongo-query` and `indexes`; the sidebar tree is fed per engine. SQL components must not know about Mongo and vice versa.

### 4.3 Console: JSON, not JavaScript
- Phase 1: **Find** tabs (filter, projection, sort, limit) and **Aggregate** tabs (pipeline as a JSON array), with a CodeMirror editor in JSON mode and field autocomplete from sampling.
- A `db.collection.find({...}).sort({...})` syntax can be added later with **our own parser** of a safe subset. **No JavaScript is executed** (no `eval`, and no `$where`/`$function` by default): that would be the easiest way around the protections.

### 4.4 Timeouts, cancellation and caps
- `maxTimeMS` as the maximum time per query (same values as PG, with a lower cap in production).
- Cancel = close the cursor and, if needed, `killOp`.
- Batches are loaded with a cap on documents and size (a document can weigh up to 16 MB); the exact count is optional, as in PG.

## 5. Security: what changes compared with PostgreSQL

In PostgreSQL read-only mode relies on `default_transaction_read_only`, a server-side option. **MongoDB has no per-session equivalent.** So:

1. **The real barrier is the user's role:** document and require, in the guide, an account with the `read` role. Example for `SECURITY-REVIEW.md`: `db.createUser({user:"hyrax_ro", pwd:passwordPrompt(), roles:[{role:"read", db:"my_database"}]})`.
2. **In the application, read-only is a guardrail:** the console only allows read operations (`find`, `aggregate`, `count`, `distinct`, `explain`); aggregations are inspected and the **`$out` and `$merge` stages are rejected**, as well as `$function`/`$accumulator`/`$where` (server-side JavaScript). Any command not on the list is rejected.
3. **Writing:** the same expiring window (10 minutes), typed confirmation of the database name in production, validated in the backend too.
4. **There is no free `ROLLBACK`:** transactions only exist on replica sets and sharded clusters. The "dry run" will be a **preview**: how many documents match the filter and a sample of them, before an `updateMany` or `deleteMany`. If the server supports transactions, a real dry run can be offered later.
5. **Concurrent-change detection when editing:** the `replaceOne`/`updateOne` filter includes `_id` and the original value of the modified fields (or of the whole document), so another person's change is not overwritten.
6. **Destructive operations** (`drop`, `deleteMany` with no filter, `updateMany` with no filter): stronger warning and the exact operation shown, like PG's SQL.
7. The same credential rules: password in the system store, never in `profiles.json`, never in the stored URI nor in the history.

## 6. Phases

Each phase ends with something usable, automated tests and a check in the real application. Relative size: S small, M medium, L large.

**M0 — Foundations (M) — ✅ done**
- ✅ Driver added; binary size and `cargo audit` measured (see 4.1).
- ✅ `engine` field in the profile (`postgres` or `mongodb`), with MongoDB-specific settings; profiles saved earlier load as `postgres`.
- ✅ Start screen: light connection list (engine badge, production mark, most recently used first) and one "New connection" button per engine.
- ✅ One connection form per engine: SRV (Atlas) toggle, replica-set nodes, auth database, TLS with an optional CA file, and engine detection when pasting a `postgresql://`, `mongodb://` or `mongodb+srv://` string.
- ✅ "Test" works for MongoDB (`buildInfo`); the URI is built without credentials and host names are validated against URI injection.
- ✅ Test base: unit tests for URI building and connection strings, plus an ignored integration test that needs a disposable `mongod` (`HYRAX_MONGO_TEST_HOST` and `HYRAX_MONGO_TEST_PORT`; optionally `HYRAX_MONGO_TEST_USER` and `HYRAX_MONGO_TEST_PASSWORD`). It only runs `buildInfo`, which writes nothing.
- Verified in the real application against a disposable `mongod`: test connection returned the server version.
- Opening a MongoDB connection from the tree or the start screen shows that the explorer arrives in M1.

**M1 — Connect and explore, read-only (L) — ✅ done** → *first useful milestone*
- Connection to **local, Atlas (`mongodb+srv`) and a company server**: hosts, SRV, user, auth database, TLS with a custom CA file; test and save.
- Tree of databases and collections; count and size.
- Collection tab: pagination, quick filter bar and JSON filter, sort, projection, document viewer with types.
- Production marking, time limit and cancel.
- Done: server → databases (with size) → collections and views tree; collection tab with a quick filter bar (`status=OPEN age>30 name~ana`, or a JSON filter), optional sort and fields, 25/50/100 documents per page, estimated count and an exact count that uses the filter; a document viewer with a tree that shows each BSON type (ObjectId, int, long, double, decimal, date…); copy as Extended JSON.
- Safety in this phase: only read commands exist in the backend; the filter, sort and projection are validated (`$where`, `$function`, `$accumulator`, `$out` and `$merge` are rejected anywhere in them), the limit is capped at 200 documents, `skip` at 1,000,000 and a page at 8 MB; every query has `maxTimeMS` (60 s by default, 5 min cap in production).
- Added after the second review: a **Documents** view (and a **Document** mode in the viewer) in the mongosh / Compass list style: keys without quotes and types as constructors (`ObjectId('…')`, `ISODate('…')`, `Decimal128('…')`, `UUID('…')`, `BinData(…)`, `Long('…')` only when outside the safe integer range). Compass shows this style by default and uses `{"$oid": …}` only in its JSON tab.
- Added after the first review: a **Table | JSON** switch for the collection (relaxed Extended JSON, like Compass: plain numbers, wrapped ObjectId/Decimal128/dates; a Long beyond the safe integer range, NaN and Infinity keep their wrapper so no data is lost), a **Tree | JSON** switch in the document viewer, and **autocomplete** in the filter, sort and fields bars.
- Autocomplete works from the documents already loaded in the tab (no extra server queries): field paths up to three levels deep, operators for a complete field, values seen in that field (quoted when needed), and, inside a JSON filter, keys, `$` operators and values. A field that never appears in the loaded documents is not suggested; the first page of an unfiltered collection gives the best coverage.
- A user who cannot list all databases (a role on a single one) sees the database given in the connection; the `read` role is still the real barrier.
- Verified against a disposable `mongod` 8.0: an integration test (databases, collections, a view, filter, sort, paging, projection, counts, BSON types, errors) and the real application (tree, collection, quick filter cross-checked against a direct `mongosh` count, document viewer).
- Not in M1: cancelling a running query (it stops at `maxTimeMS`), a quick filter for dates with time zones other than UTC, and arrays of documents in the grid beyond a one-line summary.
- Risk to watch: performance with huge collections and large documents.

**M2 — Query and analysis (L)**
- Find and Aggregate console with the comfort features of decision 1, history, copy as `mongosh`.
- Indexes and statistics, schema by sampling, `explain` as a tree.
- Export to JSON, NDJSON and CSV.

**M3 — Safe writing (L)**
- Insert, edit and delete documents with preview and concurrency control.
- Import NDJSON/JSON/CSV with a dry run (count).
- Drop a collection or database with confirmation; create an index.

**M4 — Advanced connection and wrap-up (M)**
- SSH tunnel to Mongo, X.509/AWS authentication if needed.
- Mongo-specific security review, `cargo audit`, up-to-date documentation and README, installer test.

Recommended order: M0 → M1 → M2 → M3 → M4, releasing each one. M1 already lets you look at a real database safely.

## 7. Testing strategy

- **Unit tests** without a server: URI building, validation of filters and pipelines (rejecting `$out`, `$merge`, JavaScript), BSON ↔ Extended JSON conversion, caps.
- **Integration tests** against a **disposable `mongod`**: MongoDB Server 8.0 and `mongosh` are already installed on the developer machine (`C:\Program Files\MongoDB`). Another instance is started with `--dbpath` in a temporary folder and a different port (for example 27018) and deleted when done. A single-node replica set will be needed to test transactions and realistic `explain`.
- **Fixed rule:** the MongoDB service already running on the machine (port 27017) is **not used for writing**; reads only, and only with the owner's permission. Write tests will require the database to be named `scratch`, as in PG, and `HYRAX_MONGO_TEST_*` variables.
- **Real application** driven through the WebView2 debugger with an isolated identity (as done for PG), including a connection through the SSH tunnel when M4 arrives.
- UI tests with a mocked backend, like the current ones.

## 8. Risks and open points

| Risk | Mitigation |
|---|---|
| Binary grows more than acceptable with the official driver | Measure in M0 before committing to the design; if it does not fit, evaluate another route |
| Company server with a private CA does not verify (rustls does not read the Windows store) | Custom CA PEM field, same as PG; documented |
| False sense of security from "read-only" | Say it in the UI and in `SECURITY-REVIEW.md`; require the `read` role |
| SSH tunnel + replica sets: the driver discovers the nodes' internal names and bypasses the tunnel | Use `directConnection=true` through the tunnel; warn about the limitation; verify TLS against the real server name (M4; Atlas does not need it) |
| Huge documents or collections with billions of entries | Caps on size and documents, estimated count by default, no large `skip` without a warning |
| BSON types lost when editing | Always edit on canonical Extended JSON |
| New dependencies with security notices | `cargo audit` in each phase and a record in `SECURITY-REVIEW.md` |
| Scope: Mongo is a second product inside the first | Phases with deliverables; do not over-abstract before M1 works |
| A JSON console may feel slower than `mongosh` syntax | Comfort features in M2 (autocomplete, templates, quick filters); parser for `db.col.find()` as a later phase if it is still missed |
