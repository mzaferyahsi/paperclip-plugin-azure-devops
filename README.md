# Paperclip plugin: Azure DevOps

Makes Azure DevOps pull requests, work items and builds first-class in Paperclip, the way GitHub is built in: live link chips, an issue view, agent tools that hold the credentials, webhooks and a reconciler that keep issues in step, and a review flow with an Azure DevOps status policy as the hard merge gate.

Status: beta. Built and tested against Paperclip 2026.1012.0 and 2026.1023.0. Linux hosts for the git part (macOS is untested).

**New here?** Read [docs/setup.md](docs/setup.md): prerequisites, the two identities, install and a troubleshooting table.

## What you get

- **Chips.** A pull request or work item URL in a comment shows its live state (open, draft, checks failed, ready, completed). Both `dev.azure.com` and `*.visualstudio.com` URLs work. Build URLs cannot be chips (the host drops query strings).
- **Issue view.** An "Azure DevOps" panel on each issue lists the linked pull requests (state, reviews, checks), builds and work items, and lets a board user link one by URL. A branch named `<agent>/<issue-key>-<topic>` links automatically.
- **Agent tools (51).** Read, write and gated tools run server side with the plugin's credentials. Agents do not handle credentials for these tools. See `docs/skill/SKILL.md` for the agent-facing guide.
- **Platform administration (operator, 0.13.0).** Seven additional operator tools read Azure DevOps environments and Secure File metadata, add an Approval check to an allowlisted environment and authorize named pipelines (never all pipelines) on an allowlisted Secure File. They run behind the `platformAdmin` master switch and allowlists, need a person's confirmation (two-phase, board only), and use a separate least-privilege admin identity (Administrator role on the listed environments and Secure Files only — never Project or Build Administrator). They never run pipelines; pipeline 141 stays disabled. See `docs/architecture.md` for the controls and the enable runbook.
- **Staging deploy approval (CEO, 0.15.0).** Three additional tools behind `platformAdmin.deployApproval` (default off): TechLead/QA/SecurityEng attest an exact release tuple with `ado_release_verdict_post`, and the CEO reads and decides the `kippiowl-staging` environment Approval check with `ado_environment_approval_get`/`_post`. Every control is re-checked live before a decision; the worker applies it with the admin PAT. See `docs/architecture.md` for the controls, config block, threat table and rollback.
- **Staging release bundle (0.17.0).** Three tools behind `platformAdmin.deployApproval.releaseBundle` (default off): an author-role proposer agent proposes one commit; one person accepts one card; the plugin worker then queues pipeline 140 (build) on `main` at that commit and pipeline 138 (deploy) with the digest 140 published, for 2 hours at most. Staging only. The environment approval and the three attestations still apply. See `docs/architecture.md`.
- **Events.** Service hooks wake the assignee on failed checks, conflicts and requested changes, and move an in-progress issue to in review when its pull request completes. A reconciler re-reads open pull requests so lost webhooks heal within minutes.
- **Review flow.** Two bot identities (author and reviewer). The reviewer publishes a `paperclip/review` PR status that you make a required Status policy. The plugin never sets `bypassPolicy`.
- **Gated actions.** Completing or abandoning a pull request and running protected pipelines use a two phase ledger: propose, approve, then apply against the live state. Approval is a person on the issue by default, or approver agents (for example the CEO and Tech Lead) after the plugin has verified the QA and Security verdicts, the pipeline and any staging gate on the exact commit.

## What it cannot do (host limits)

Git over HTTPS credentials for agents, workspace cleanup after a merge, and work product refresh are hard-wired to GitHub in Paperclip core. The plugin works around them: agents get HTTPS git access through a brokered credential helper, and tool results carry a ready work product payload. `docs/architecture.md` lists the upstream asks.

## Setup

Install the plugin (`paperclipai plugin install --local <path>`), open the company settings, **Azure DevOps**. The setup panel at the top does the work:

1. Paste your organization URL. The Entra tenant is read from Azure DevOps itself.
2. Connect the two bots: either it finds secrets you already created (names like `azure-devops/author-client-id`) or you paste the two service principals once and it stores them as Paperclip secrets. Both service principals need Basic access in the organization.
3. Find projects and tick the ones agents may use (a single visible project is selected for you).
4. Roles are suggested from your agents (engineers author, QA reviews, leads review and operate) and can be edited on the "Agents and access" tab.
5. One click gives every agent (present and future) the tools through one company-wide profile; the plugin enforces roles on every call. A per-role mode is available on the "Agents and access" tab. Another click turns on live link chips.
6. "Check permissions" reads what each bot can do in Azure DevOps and links to the pages where to fix it.
7. **Git without SSH keys.** The Git access step shows one command to run once on the host (`sudo .../host/install-git-access.sh --org <org> --projects <list>`), then one click puts the wrapper first on the PATH of the default execution environment, so every agent and project, including future ones, uses it. Agents then use plain `git clone/fetch/push`. A new agent needs nothing: it can clone and read at once (reviewer token), and becomes able to push by being ticked as an author, or for all agents with "Every agent is an author". The plugin hands each run a short-lived bot token (authors: author bot, everyone else: reviewer bot) after checking scope, run and rate limit. Nothing is stored in HOME, repositories or agent environments; read the limits in `docs/architecture.md` (the token is org-wide for about an hour). GitHub and other hosts keep their own credentials.
8. Optional: prepare webhook secrets (random; the values are shown once, so copy them then) and add the service hooks from the recipe it shows. Without webhooks the reconciler keeps state current within minutes.

"Set up everything I can" runs all steps that need no decision. Prerequisites outside Paperclip: the two Entra app registrations with a client secret each, and their organization seats.

## Security model

- Webhook deliveries are hints. They are authenticated (token header and basic auth, constant time), deduplicated into an inbox, and turned into a fetch by id with the plugin's own credentials. Payload fields never drive an action.
- Every tool checks the caller's role from the Azure DevOps settings. Author and reviewer are different identities, and the author of a pull request cannot review it.
- Free text from Azure DevOps is off by default, fenced and labelled as untrusted when requested, and neutralised so it cannot trip the host's injection scanner and block the whole result.
- Gated actions bind the human confirmation to a hash of the exact arguments and re-check live state before executing; phase 2 ignores any arguments the agent sends again.
- Every Azure DevOps write is audited and carries a provenance footer.

## Development

```
npm install
npm test            # unit, scenario (real Postgres + fake Azure DevOps), tool and wiring tests
npm run build       # syncs manifest tools from src/tools/catalog.ts, validates, bundles
```

Tests that need Postgres use the embedded binaries of a Paperclip install (`PC_HOST_NODE_MODULES` points at its `node_modules`) and skip when absent. `docs/architecture.md` explains the design.

## Licence

MIT.
