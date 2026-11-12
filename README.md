<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Hyrax Studio logo" width="120" />
</p>

<h1 align="center">Hyrax Studio</h1>

<p align="center">
  A lightweight desktop database client, built so you don't break production.<br />
  PostgreSQL today, and MongoDB read-only exploration.<br />
  Rust + Tauri 2 on the backend, React + TypeScript on the front end.
</p>

> **Status: early version (0.1).** It is used daily in development, but it has not been tested against a real production cluster or outside Windows. Read [Current limitations](#current-limitations) before relying on it. **The interface is currently in Spanish.**

## Why Hyrax Studio

DataGrip and DBeaver do a lot, sometimes too much, and they are heavy. Hyrax Studio aims at what you use every day (browsing the schema, querying, reviewing and fixing data) with a small binary, instant startup and low memory use. And with one design rule: **a wrong click should not cost you a table**. That is why it starts read-only, asks for confirmation before writing and shows the exact SQL before applying any change.

## What it does

**Browse**
- Server → databases → schemas → tables/views → columns tree, lazy-loaded and filterable.
- `Ctrl+N` jumps to any table, view, function, procedure or sequence by name; `Ctrl+Shift+A` opens the command palette.
- DDL for tables, views, functions and sequences, generated from the catalog.
- Foreign keys are navigable both ways: from a value to the related row and, from a row, to whatever references it.
- **Structure** tab: columns, keys, indexes, constraints, triggers, statistics and size.

**Query**
- SQL editor with highlighting, autocomplete (aliases, `JOIN` suggested from foreign keys, functions with their signature, snippets), history, formatting and find/replace.
- `Ctrl+Enter` runs the statement under the cursor; `Ctrl+Shift+Enter` runs the whole script. `:name` parameters, time limit, cancel.
- Execution plan as a tree (Explain/Analyze) with the most expensive node highlighted and warnings for bad estimates.
- Open and save scripts as `.sql` files.

**Work with data**
- Table viewer with pagination, multi-column sorting, per-column filters (`>5`, `=x`, `^x`, `null`…), estimated or exact count and a cell inspector with formatted JSON.
- **Safe editing**: edited cells, new rows and deleted rows stay as pending changes; you review the SQL and all of it is applied together in one transaction, with concurrent-change detection.
- Import CSV/TSV/JSON with column mapping and a dry run first; export to CSV, JSON or `INSERT` statements, streamed.
- Pin and compare results; row view as a form.
- Right-click on tables, views and databases: open, view DDL, new query, copy name and drop (requires write mode, shows the SQL and asks you to type the name).

**MongoDB (read-only)**
- Tree of databases, collections and views; collection tab with a quick filter (`status=OPEN age>30 name~ana`) or JSON filter, sort, fields and paging, estimated or exact counts.
- **Autocomplete** in the filter, sort and fields bars: field names (including nested ones such as `shipping.city`), operators and the values seen in the loaded documents; it also works inside a JSON filter (keys, `$` operators and values). Arrow keys and Tab or Enter choose, Esc closes and Ctrl+Space opens the list.
- **Documents, Table or JSON view** of the collection. *Documents* (the default) is the mongosh / Compass list style (`_id: ObjectId('…')`, keys without quotes); *JSON* is Extended JSON. The document viewer alternates between the mongosh style (default), a tree (every BSON type visible) and JSON. The app remembers your choice. Filters that run JavaScript on the server (`$where`, `$function`) are rejected.
- PostgreSQL and MongoDB connections can be open at the same time.

**Connect**
- A start screen with your saved connections (engine badge, production mark, most recently used first) and a "New connection" button per engine.
- Saved connections, with pasting of `postgresql://user:password@host:5432/db?sslmode=…`, `mongodb://…` or `mongodb+srv://…` strings (the engine is detected from the scheme).
- **SSH tunnel** with a private key or a password. The SSH server's host key is never accepted blindly: the first time its SHA-256 fingerprint is shown for you to confirm, it is pinned to the connection, and if it ever changes Hyrax refuses to connect.

**Safety**
- Read-only by default; write mode needs confirmation and expires by itself after 10 minutes, enforced on the server side.
- Connections can be marked as **production**, with stronger confirmation.
- Passwords live in the operating system credential store, never in files. TLS with certificate verification.
- Warnings for `DELETE`/`UPDATE` without `WHERE`, `DROP` and `TRUNCATE`, and a "Test (ROLLBACK)" button to see the effect without saving anything.
- Details and residual risks in [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md).

Dark, light or automatic theme. Inter and JetBrains Mono fonts are bundled with the app.

## Current limitations

What you should know before trusting Hyrax:

**Security**
- **The app's read-only mode is a guardrail, not a barrier.** Someone who knows Postgres can find ways around it (for example, server-side functions). The real protection is connecting with a database account that has **no write permissions**.
- The production confirmation only works if you mark the connection as production; Hyrax cannot guess it.
- With `ssl=require` (no verification) a man in the middle could impersonate the server. Use "Encrypted and verify the certificate".
- Query history is stored in plain text on your machine while it is enabled.
- With an SSH tunnel open, the local port (`127.0.0.1` only) accepts connections from any process on your machine for the duration of the session, as with any port forward; Postgres still requires its own authentication.
- The tunnel was tested against a local `sshd` with a private key; SSH password authentication and TLS verification through the tunnel have not been tested end to end. Each open database of a tunneled connection opens its own SSH session.
- Dependencies: `cargo audit` flags `crypto-bigint` (timing variations, through `russh`) with no fix available yet; details in [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md).

**Maturity**
- Tested on **Windows** only. Linux and macOS have not been tested.
- Not tested against a real production cluster, only against disposable PostgreSQL 17 instances.
- No signed installer and no automatic updates yet.
- Requires PostgreSQL 11 or later.

**Data and performance**
- All values are shown as text (Postgres simple protocol); there are no native types in the grid.
- A result with more than 100,000 rows is cancelled on the server and shown as "100,000+"; up to 5,000 rows per result are kept on screen.
- Import supports up to 200,000 rows or 64 MB per file, in UTF-8.
- Editing requires tables with a **primary key**; views are read-only.
- Comparing results only compares the loaded rows (up to 5,000), not whole tables.
- `:name` parameters are substituted as escaped literals, not as bound protocol parameters, and are not detected inside strings, comments or `$$` blocks.

**Not available yet**
- SSH tunnel with `ssh-agent`, jump hosts (`ProxyJump`) or reading `~/.ssh/known_hosts`: today only a private key file or a password, with the fingerprint pinned to the connection. Connection strings with libpq parameters other than `sslmode` and `sslrootcert`.
- Importing connections from DBeaver or pgAdmin.
- ER diagrams, schema comparison, session monitor, role and privilege management.
- Dropping schemas; "Go to object" does not list indexes, constraints or triggers as entries of their own.
- Context-aware keyword autocomplete, a scripts panel and custom snippets.
- **MongoDB** is read-only for now: you can connect (local, Atlas `mongodb+srv`, replica sets, TLS with a custom CA), browse databases and collections, filter, sort and page through documents, and inspect each one with its BSON types. There is no query console, `explain`, index view, export or writing yet ([plan](docs/MONGODB.md)). MongoDB has no per-session read-only mode, so use a user with the `read` role. A company server with a private CA needs its CA as a PEM file (MongoDB uses its own certificate roots, not the Windows store).

The full plan is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Recommended use in production

1. Connect with a database account that has **no write permissions** (there is an example role in [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md)).
2. Choose "Encrypted and verify the certificate".
3. Mark the connection as production.
4. Enable write mode only when needed and always review the SQL before applying.

## Saved data and how to erase it

Connections are stored in your user data folder (`%APPDATA%\dev.osen.hyrax\profiles.json`), and passwords and SSH keys in the Windows Credential Manager. **None of that ships inside the installer**: a fresh install on another machine or user account starts empty. On a machine where you already used the app, the installed version reads those same connections, and uninstalling does not remove them.

To leave the app as if freshly installed: `Ctrl+Shift+A` → "Borrar conexiones y contraseñas guardadas…" (you must type `BORRAR`). It removes the connections, their passwords and SSH keys, and optionally the query history. It does not touch any database.

## Run from source

Requirements: Rust (MSVC on Windows), Node 20+ and WebView2 (included in Windows 11).

```
npm install
npm run tauri dev      # development
npm run tauri build    # installer
```

## Tests

```
npm test                         # UI, with a mocked backend
cd src-tauri && cargo test       # backend unit tests
```

The backend integration tests are marked `#[ignore]` and need real servers. The read tests use `HYRAX_TEST_HOST/PORT/DB/USER/PASSWORD`. The **write** tests use `HYRAX_WRITE_TEST_*` and refuse to run unless the database is named `scratch`: use them only with a disposable Postgres, never with real data. The TLS tests also need `HYRAX_TLS_CA_PATH`. The MongoDB connection test needs a disposable `mongod` (`HYRAX_MONGO_TEST_HOST` and `HYRAX_MONGO_TEST_PORT`); it only reads the server version.

```
cargo test -- --include-ignored
```

## Documentation

- [docs/ROADMAP.md](docs/ROADMAP.md): finished and pending stages.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): structure and design decisions.
- [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md): security review and residual risks.
- [docs/MONGODB.md](docs/MONGODB.md): plan for MongoDB support.
- [SECURITY.md](SECURITY.md): how to report vulnerabilities.

## Project status and contributions

Hyrax Studio is a personal project under active development. Bug reports are welcome; for security problems use the private channel described in [SECURITY.md](SECURITY.md), not a public issue.

## License

[MIT](LICENSE).
