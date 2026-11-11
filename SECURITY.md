# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through the repository's security advisories ("Report a vulnerability" in the Security tab). Include the steps to reproduce, the affected version, and what an attacker could do.

## Scope

PgDesk is a desktop client that stores connection settings locally and keeps passwords in the operating system credential store. Reports about the following are in scope:

- credentials leaking to disk, logs, the web view or the network
- SQL built from unescaped input
- ways around the read-only mode, the production confirmation or the write timeout that do not require running SQL the user typed
- weaknesses in the content security policy or in the permissions granted to the web view
- TLS verification problems

Known limits are documented in `docs/SEGURIDAD.md` (in Spanish).
