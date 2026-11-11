# Security review (2026-11-10)

Scope: Hyrax v0.1 after stages 1–8, with use against production databases in mind. Method: code reading (SQL construction, data crossing into the webview, credential storage, TLS, Tauri configuration), dependency audit (`npm audit`, `cargo audit`) and tests against real Postgres servers, including an end-to-end test with the real application driven through the WebView2 debugger.

## Summary

No exploitable vulnerabilities were found in the dependencies (as of the original version; see the SSH tunnel update for the current situation) nor SQL injection. There were four design problems that mattered for production, all fixed (S-01 to S-04), plus several minor hardenings. What remains true: the application's read-only mode is a safety net against mistakes, **not** a barrier against someone who wants to write; for production the real barrier is a database account without write permissions (see "Recommendations").

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| S-01 | High | Passwords were stored in plain text in `profiles.json` and also sent to the webview with every connection listing | **Fixed.** They go to the Windows Credential Manager (Keychain / Secret Service on other systems). They never reach the webview (only a "has password" flag). The file does not contain them (a test checks it). Old passwords are migrated automatically, re-reading them before deleting them from the file |
| S-02 | High | "SSL required" encrypted but accepted any certificate: vulnerable to a man in the middle | **Mitigated.** New "Encrypted and verify the certificate" mode (chain and host name; own CA optional). The non-verifying mode still exists with a visible warning. Tested against a server with a self-signed certificate: without the CA it rejects, with the CA it connects |
| S-03 | High | Read-only mode could be turned off with SQL (`SET default_transaction_read_only = off`, `BEGIN READ WRITE`, `set_config`, `RESET ALL`, `DO`…) | **Fixed against mistakes.** Hyrax's backend rejects those statements while the session is read-only. It is not a barrier against an attacker: see residual risks |
| S-04 | Medium | The production confirmation (typing the database name) only existed in the UI | **Fixed.** The backend requires it and rejects the attempt even if the command is called directly (checked in the real application) |
| S-05 | Medium | No Content Security Policy (CSP) on the window | **Fixed.** Strict CSP: no `unsafe-eval`, no inline scripts, no external connections, images or frames. Verified in a binary with embedded resources |
| S-06 | Medium | The automatic return to read-only after 10 minutes depended on a UI timer | **Fixed.** It is also enforced on the server side on every operation |
| S-07 | Medium | In production, queries could be launched with no time limit | **Fixed.** A 5-minute cap enforced on the server side, and the "No limit" option is not offered in production |
| S-08 | Low | The export path was not validated in the backend | **Fixed.** It must be absolute, end in the format's extension, and the folder must exist |
| S-09 | Low | Query history is stored unencrypted in the window's local storage and may contain sensitive data | **Mitigated.** "Save history" switch and automatic deletion when a connection is removed. It is not encrypted |
| S-10 | Info | Dependencies | `npm audit`: 0 vulnerabilities. `cargo audit`: 0 vulnerabilities and 5 informational notices (`glib`, `proc-macro-error`, `zbus*`), all in code that is only compiled on Linux |
| S-11 | Info | SQL injection | All points that build SQL were reviewed. Identifiers with `quote_ident`; filter values as escaped literals (`E'...'` if there are backslashes); data changes with bound parameters; column types come from the server's catalog, never from the client; row counts, timeouts and modes are numbers or constants |
| S-12 | Accepted | The CSP allows inline styles | React and CodeMirror need them. It does not allow running code |
| S-13 | Accepted | Anyone who controls your Windows session can read the Credential Manager | It is the normal trust boundary of any database client |
| S-14 | Pending | No code signing or automatic updates | For public distribution |

## Update (2026-11-11): SSH tunnel, connection strings and rename to Hyrax

- **SSH tunnel** (`src-tauri/src/tunnel.rs`): local port forwarding with `russh`. The local port listens only on `127.0.0.1` and is closed when the session is dropped. The **SSH server's host key is pinned by its SHA-256 fingerprint in the connection**: with no saved fingerprint the connection fails returning the fingerprint for confirmation; if it later changes, it fails with a warning of a possible man-in-the-middle attack. An unknown key is never silently accepted. The key passphrase or SSH password goes to the system store (`ssh:<id>` entry), not to `profiles.json`.
- With verified TLS through the tunnel, the certificate is validated against the real host (the connection goes to `127.0.0.1` with `hostaddr` but `host` stays the server).
- **Connection strings**: parsed in the UI; the password goes to the system store when saving and the field is cleared once applied. Unknown `sslmode` values are rejected and `prefer`/`allow` are not silently translated.
- **Rename PgDesk → Hyrax**: the app identifier and the credential store service changed. On startup the old `profiles.json` is copied once, and the first read of each password moves it from the `pgdesk` service to `hyrax`. Both paths have automated tests.
- **Dependency audit after adding `russh`** (`cargo audit`, 2026-11-11): `russh 0.54` had two notices of its own (RUSTSEC-2026-0153 and -0154, unbounded allocation from server-provided data); they were fixed by upgrading to `russh 0.60.3`. What remains: `crypto-bigint 0.7.0-rc.28` (RUSTSEC-2026-0387, timing variations in operations that should be constant-time), which comes from `russh` and is compiled; and `rsa 0.10.0-rc.16` (RUSTSEC-2023-0071, Marvin attack), which appears in `Cargo.lock` but is **not compiled** (`cargo tree -i rsa` does not find it). Neither can be fixed from Hyrax: they depend on a new version of `russh`. They are timing side channels that require an attacker to measure operations with your private key on your own machine. They will be reviewed when `russh` is updated. `npm audit`: 0 vulnerabilities.
- Code review of the tunnel (findings fixed): time limit also during authentication; the private key is decrypted off the async threads; if the SSH server cannot forward to Postgres the error says so up front (checked against an unreachable target); the SSH secret is only stored when the tunnel is enabled and can be forgotten; changing the SSH host or port invalidates the trusted fingerprint; `~` in the key path; validated ports; `postgresql://h:80/db` no longer loses the port and strings without a host are rejected with a clear message.
- **Erasing saved data** (`reset_app_data`): typed confirmation (`BORRAR`) also validated in the backend; it removes `profiles.json`, the passwords and SSH keys from the system store (including those of the old `pgdesk` service) and the old PgDesk copy. If a credential cannot be deleted, the connections file is kept so it can be retried. The PgDesk migration now happens only once (`.legacy-checked` marker): before, after erasing the connections they reappeared from the old folder; a test in the real app caught it and it is now covered by automated tests. The complete erase was tested with temporary folders and the real Windows store using test ids; it was not repeated in the real app because it cleans a folder shared with the developer's real data.
- Known cost: each open database of a tunneled profile opens its own SSH session (with its own authentication); one shared tunnel per profile is pending.
- New residual risks: any local process can open the tunnel's port while the session is open; SSH password authentication and TLS through the tunnel were not tested end to end (private key, unknown fingerprint, changed fingerprint, unauthorized key and port closing were, against a local `sshd`).

## Update (2026-11-11): stages 9 to 11

New surface and how it was bounded. This update is a review of the design and the tests; it does not repeat the dependency audit of S-10.

| Feature | Risk considered | Control |
|---|---|---|
| Open and save scripts, open files to import | The web UI reading or writing arbitrary paths | The dialogs are opened from Rust and the path never comes from the UI. A file is only saved again over paths the user chose in a dialog during the session. Maximum size (8 MB scripts, 64 MB data) and mandatory UTF-8. No permission was added to the window |
| Import | Writing data by accident or leaving the table half-loaded | Requires write mode (and therefore the production confirmation), takes the session's write lock, validates columns against the catalog, uses bound parameters with the type taken from the catalog, and everything happens in one transaction: an error rolls everything back. "Dry run" ends in `ROLLBACK`. Tables only (not views or system tables). At most 200,000 rows per import |
| `:name` parameters | SQL injection through the value | They are substituted as escaped literals (doubled quotes, `E'…'` with backslashes, NUL rejected), with a test that `x'; DROP TABLE t; --` stays inside its literal. The dangerous-statement warning and the read-only filter apply to the final text. The value is typed by the user over their own SQL, so it does not open a new channel |
| Structure, DDL and object search | Excessive writes or load | Read-only catalog queries only, valid in read-only sessions. Cap of 20,000 objects |
| Running the statement at the cursor | Running too much (or too little) | Ctrl+Enter only runs the current statement or the selection, which lowers the risk of launching a whole script by accident; "Run all" is explicit and goes through the same dangerous-statement warning |
| Pinned results | Sensitive data in memory | They live only in the window's memory (maximum 8) and are lost on close; they are not written to disk |

### Dropping tables, views and databases (context menu)

| Risk | Control |
|---|---|
| Dropping something with a wrong click | Action only from the right-click menu, never as a visible button. A dialog shows the exact SQL and requires **typing the full name**. The backend requires it again (`check_confirm`), even if the command is called directly |
| Dropping in a read-only session | The backend rejects it if the session is read-only. For a database it requires write mode enabled on some database of that server. Enabling it from the dialog goes through the same production confirmation (typing the database name) |
| Deleting too much with `CASCADE` | It is a separate checkbox, off by default, and the SQL shown reflects it. Without it, if something depends on the object, it fails and nothing is dropped |
| Leaving a lock hanging | `lock_timeout` of 5 s inside a transaction; if it fails it rolls back |
| Injection through the name | Identifiers with `quote_ident` (with a test of a malicious name). Only a fixed set of object types is accepted; system schemas and template databases are rejected |
| Dropping a database you are connected to | Hyrax closes its own session to that database and drops from a maintenance connection (`postgres`, or `template1` if `postgres` is dropped). If there are other people's connections it fails with a clear message; "Force" (`WITH (FORCE)`, PostgreSQL 13+) disconnects them and is a separate checkbox |

This does **not** replace the account without write permissions: with a read-only account the server rejects all of this anyway. There is also no trash or undo: without a backup, what is dropped does not come back.

New residual risk: the content of an imported CSV/JSON is inserted as is; if it contains data the user should not load, Hyrax does not detect it. The preview and the dry run exist to review it first.

## Controls that protect production

- New connections open **read-only**. Enabling write mode requires confirmation; on a connection marked as **production** you must type the database name, and the server checks it again.
- Write mode turns itself off after 10 minutes, on the server.
- Data changes are prepared on screen and applied **all together in one transaction** after reviewing the SQL. Each row is checked against its original value: if someone else changed it, nothing is applied. Tables with a primary key only.
- In the SQL editor: a warning before running `DELETE`/`UPDATE` without `WHERE`, `TRUNCATE` or `DROP`, and a "Test (ROLLBACK)" that runs and rolls back to see the effect without saving anything.
- Maximum time per query (60 s by default, 5 min cap in production), cancellation, and reads capped in memory.
- `EXPLAIN ANALYZE` (which runs the query) is only available in read-only mode.
- Minimal window permissions: only the "save file" dialog. No file system or network access from the UI (opening and saving scripts or data goes through Rust commands that open their own dialog).

## Residual risks and limits

1. **Read-only is a guardrail.** It is implemented with Postgres's `default_transaction_read_only` plus a statement filter. A knowledgeable user can find another way around it (for example, server-side functions). Do not use it as the only protection against someone who wants to write.
2. **The production confirmation depends on you marking the connection as production.** Hyrax cannot guess it.
3. **If you use `ssl=require`** (no verification), a man in the middle can impersonate the server.
4. **Query history** stays in plain text on your machine while it is enabled.
5. **Not tested** against a real production cluster, nor on Linux or macOS, nor with a signed installer. The end-to-end test used a disposable Postgres and a build with embedded resources, not an installer.
6. **The migration of an existing connection's password** into the system store was covered by automated tests, but not tried against a real server's credentials. After upgrading from PgDesk, open each saved connection and check that it connects.

## Recommendations for production

Create an account that cannot write; it is the only real barrier:

```sql
CREATE ROLE hyrax_ro LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE database_name TO hyrax_ro;
GRANT pg_read_all_data TO hyrax_ro;
ALTER ROLE hyrax_ro SET default_transaction_read_only = on;
ALTER ROLE hyrax_ro SET statement_timeout = '60s';
ALTER ROLE hyrax_ro SET idle_in_transaction_session_timeout = '30s';
```

(`pg_read_all_data` requires PostgreSQL 14 or later; on earlier versions grant `SELECT` per schema.)

- Connect with **"Encrypted and verify the certificate"** and, if the CA is your own, give its PEM file.
- Mark the connection as **production**.
- Use a different write account, short-lived, only when editing is needed.
- Prefer reaching the server over a VPN or tunnel; do not expose it to the Internet.

## Publishing the repository

- Reviewed: there are no passwords, server addresses or personal paths in the tracked files.
- Commits carry the name and email configured in git on the author's machine; if the email should not be public, change it before publishing (`git config user.email`, and rewrite history if there are already commits).
- License: MIT.
- `SECURITY.md` explains how to report problems; use the repository's private security advisories.

## How it was verified

- Backend (2026-11-11, after the rename and the tunnel): 44 unit tests and 22 integration tests. 20 of the integration tests were run against a disposable PostgreSQL 17.5 created with `initdb` in a temporary folder (the 2 TLS tests need a certificate), including the SSH tunnel test against a temporary local `sshd`: unknown fingerprint, changed fingerprint, unauthorized user key, unreachable target, successful connection and port closing when the session is dropped. There are also automated tests of the profile and password migration from PgDesk. Dependency scanning with `cargo audit` and `npm audit`.
- UI: 110 tests (with a mocked backend and of the pure logic: statements, parameters, plan, CSV/JSON, comparison, JOIN by FK, connection strings).
- Real application (2026-11-11), with an isolated configuration and WebView profile and the disposable database: Ctrl+N, foreign-key jumps both ways, structure and DDL, virtualized grid (exact, gap-free scrolling with 200 loaded rows), statement under the cursor, parameters, plan with ANALYZE, JOIN suggested by FK, find and replace, row view editing through to applying on the database, comparison, and the import and file commands through the real Tauri bridge (dry run, import, atomic rejection of a duplicate). The native open and save dialogs could not be automated: their path logic is covered by unit tests and the dialog itself was not seen on screen.
- Real application: credential migration, verified TLS connection, editing with real apply and check on the database, production confirmation, server rejection of attempts to bypass it, screenshots of both themes and CSP probes.
