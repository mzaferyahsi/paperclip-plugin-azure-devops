# Security

Report problems privately through the repository's GitHub security advisories (Security tab, "Report a vulnerability"), not in a public issue. Include the plugin version and what you observed. The plugin runs as trusted code inside the Paperclip worker and its UI runs same-origin with the board session: install only builds you trust.

Known host exposures this plugin cannot remove (see docs/architecture.md): the webhook route is public and the host stores request headers of every delivery; use dedicated low-value hook secrets and an edge rate limit.

## Admin PAT custody and the relaxed principle

The principle "the plugin never edits permissions" is relaxed only for the platform administration tools, and from 0.15.0 for one further narrow path: with `platformAdmin.deployApproval.enabled` (default off), the admin PAT is used to read the pending Approval check on an exact non-production allowlisted environment and to set that one approval's status after every documented control holds live (see docs/architecture.md, "Staging deploy approval"). The PAT exists only inside the worker, resolved at call time through `identities.admin`; it is never logged, returned, stored in the database or written to audit rows, and error text is scrubbed before it reaches an agent. No other use of the admin identity was added: only the approvals GET/PATCH and the read GETs of this feature (check configuration, environment, build facts). The decision is made by the single `deploy_approver` agent (the CEO) through the plugin tools, one decision per approval id, every decision audited without secrets.
