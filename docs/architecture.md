# Architecture

## Principles

1. **Webhooks are hints, the reconciler is the truth.** Service hook deliveries are authenticated (token header plus basic auth, constant time), written to an inbox, and turned into a fetch by id with the plugin's own credentials. A payload field never drives an action. A reconciler re-reads open pull requests on a schedule, so a lost delivery heals.
2. **Two identities.** An author identity writes; a reviewer identity votes and posts the `paperclip/review` status. The author of a pull request cannot review it. The plugin never sends `bypassPolicy`.
3. **The plugin holds the credentials.** Agents call `ado_*` tools; the worker adds credentials. For git, a credential helper asks the plugin for a short-lived token per command.
4. **Gated actions are two phase.** Completing or abandoning a pull request and running protected pipelines are proposed, bound to a hash of the exact arguments, approved, re-validated against live state, then applied by the plugin. Approval is a person on the issue (board mode, human-only cards; an agent-accepted card counts for nothing), or configured approver agents (approvers mode), or both in sequence.

### Merge approval by approvers

Verdicts (who voted what, by function, on which exact commit) and staging gate results are rows in the plugin's own tables, written by its tools. The approve tool recomputes every condition at the moment of approval and again at apply: required verdicts on the current head commit, a blocking build or status policy, no active review threads, a staging gate result where required, and separation of duties (an approver did not propose, author or give a verdict on the pull request). Decisions come from the ledger and live Azure DevOps state, never from pull request text. A silent approver escalates to the board after a deadline.
5. **Untrusted text stays fenced.** Titles, descriptions, comments and logs from Azure DevOps are off by default, labelled as untrusted when requested, and neutralised so they cannot trip the host's injection scanner.

## Components

| Part | Where | Job |
| --- | --- | --- |
| Worker | `src/worker.ts` | Registers data, actions, jobs, webhook handler, tools and the git credential route. |
| ADO client | `src/ado/` | REST 7.1, Entra client-credentials or PAT, rate budget (TSTU aware), error mapping. |
| Store | `migrations/`, `src/store.ts` | Plugin tables (pull requests, work items, builds, links, inbox, actions, audit, effects) in the plugin's own namespace. |
| Sync | `src/delta.ts`, `src/reconcile.ts`, `src/webhook.ts` | Turn events and polls into state changes and issue effects, idempotently. |
| Tools | `src/tools/` | 47 tools; role checks in the plugin; gate protocol in `gate.ts`. |
| Chips | `src/provider.ts` | Object references for pull request and work item URLs. |
| UI | `src/ui/` | Settings page with setup wizard, issue panel, health widget. |
| Git access | `src/gitbroker.ts`, `host/` | Plugin API route plus a root-owned git wrapper and credential helper. |

## Git access

A root-owned wrapper (`/opt/paperclip-ado/bin/git`) runs the real git with `-c` credential settings for `dev.azure.com` only, and rewrites old SSH remotes to HTTPS for the configured projects. `-c` settings are used because managed runs switch the system and user git config off. The helper calls `POST /api/plugins/mzaferyahsi.azure-devops/api/git/credentials` with the run's own API key. The plugin checks that the run is live, the repository is in scope and the rate limit (120 per minute), picks the identity by role (author bot for authors, reviewer bot for everyone else), audits the request, and returns a token. Nothing is stored on disk.

### What an agent can do with the token

Be clear about the limits. The token is an Entra access token for the whole Azure DevOps organization (about an hour) or, for a PAT identity, the PAT itself. Scope is enforced when the token is issued, not by Azure DevOps afterwards. A malicious agent that already runs code in its sandbox could use that token for other repositories in the same organization within its permissions. Mitigate with Azure DevOps permissions: give the author identity only the projects and rights it needs, and keep the reviewer read-only. The plugin cannot narrow an Entra token further.

## Credentials and secrets

Client ids, client secrets, PATs and webhook secrets are Paperclip secrets referenced by id. Tokens are cached in memory only. Secret reads are cached briefly to stay under the host's resolution limit.

## Host limits and upstream asks

Some behavior is wired to GitHub in Paperclip core: the Connectors gallery is a static list, project workspace refresh uses its own git, and work product refresh is GitHub only. Asks that would remove workarounds: provider-neutral merge resolution, pluggable git credential providers, plugin-registered connector cards, capability upgrades without reinstall, show-once secrets, a stable run-liveness API.


## Reading and managing pipelines without a PAT

Exploration tools are read only and return allowlisted fields: no variable values, no service connection URLs or credentials, no agent capabilities, no e-mail addresses. Pipeline and repository creation are off by default, always confirmed by a person, and the plugin never edits branch policies, permissions, service connections or variable groups: those stay with an Azure DevOps administrator. The one exception is described in "Platform administration" below.

## Platform administration (environment checks and Secure File permissions)

The principle "the plugin never edits permissions" is relaxed, and only for the platform administration tools (environment approval checks and Secure File pipeline permissions). It stays in force for everything else. These tools are always behind all of the following controls:

- **Master switch.** `platformAdmin.enabled` is `false` by default. While it is off, every platform administration tool refuses with `not_enabled`.
- **Allowlists, default deny.** `platformAdmin.environments` and `platformAdmin.secureFiles` list exact names (at most 20 each, same name shape as the exploration tools, no wildcards). `platformAdmin.pipelineIds` lists positive pipeline ids (at most 50). An empty list allows nothing. The allowlists apply even if the credential is over-privileged.
- **Human confirmation.** Changes are two-phase and are confirmed by a person; approver agents cannot decide them.
- **Separate admin identity.** `identities.admin` has the same shape as the author and reviewer identities (secrets only as `secret_ref`). Its secrets must differ from every other secret in the settings. It is resolved at call time through the host, kept in memory only (five minutes), and never logged, returned, stored in the database or written to audit rows. It is not a `connection_state` role and needs no migration. Only the platform administration tools use it: the read path and its fallback use only the reviewer and author identities. When it is missing, the tools fail with `not_configured` and name the setting.
- **Org-level identities client.** Approver lookup uses the organization identities host (`https://vssps.dev.azure.com/{org}`, or `https://{org}.vssps.visualstudio.com` for the visualstudio.com host form) with the admin identity.

Grant the admin identity only what these tools need: the Administrator role on the listed environments and Secure Files, and project read access. Do not make it a project or build administrator.

### Deploy approval plumbing (default disabled)

`platformAdmin.deployApproval` adds a separate, default-deny scope: exact non-production environments must also be in `platformAdmin.environments`; deploy/build pipeline lists contain at most three ids each. Enabling requires the platform master switch, admin identity, one isolated deploy approver, exact image repository and branch, and three disjoint reviewer functions (`techlead`, `qa`, `security`). The approver cannot be an author, reviewer or verdict agent. `deploy_approver` grants no other role and this plumbing slice exposes no new tools.

Only admin-bound API instances may list or decide approvals, read a check configuration or read strict build facts. Approval reads require `id`, `status`, `steps[].assignedApprover.id`, step status, `owner.id` (run), `pipeline.id`, and validate optional `checkConfiguration.id`/resource links. Check reads require `id`, `type.id`/`name`, `resource.type`/numeric-string `id`. Build facts require `id`, `definition.id`, status, optional result, source branch/version, reason, requester identity ids, and object template parameters or JSON-object parameters. Conflicting parameter sources and unknown security-relevant shapes fail closed with value-free typed errors. These approval association fields remain explicit assumptions until upstream response evidence is available; no alternate shape is guessed.

The decision PATCH is exactly `[{approvalId,status,comment}]` at `pipelines/approvals` (`7.1-preview`); reads expand steps. Admin HTTP errors omit server messages and network exception names to avoid reflecting credentials. Ordinary reads still resolve only reviewer/author credentials. Future evaluator and ledger slices must prove environment/run bindings and revalidate before invoking the decision; these API methods alone are not authorization to deploy. Tests use only fake ADO; no installation, configuration or pipeline changes are part of this slice.

### Runbook: how the board enables this

1. After board approval `ad16c9d9-168d-49e5-b090-611ce20dc422`, an Azure DevOps administrator creates the least-privilege credential (short-lived PAT or Entra app) with the Administrator security role on the environment `kippiowl-staging` and the four named Secure Files, plus project read. Nothing wider. The plugin never grants or edits Azure DevOps permissions itself.
2. Bind the credential's secret ids as Paperclip secrets and set them in `identities.admin` (secret refs only; they must differ from every other bound secret).
3. Set the `platformAdmin` config: `enabled: true`, and the allowlists (`environments`, `secureFiles`, `pipelineIds`). Empty lists allow nothing.
4. Upgrade the installed plugin with `scripts/upgrade-live.sh` (it re-applies the host envelope patch; it does not touch settings or secrets).
5. PlatformEng (operator role) can then use the seven tools. The two write tools put a confirmation card on the issue that a person approves; approver agents cannot decide them. The `/api/plugins/tools` listing only shows the tools after this install step.

Pipeline 141 stays disabled; these tools never run pipelines. Every write is audited with resolved target ids and outcome, never secrets.

### Staging deploy approval (deployApprover, 0.15.0)

When the deploy pipeline (138) reaches the `kippiowl-staging` environment, the Approval check waits for the admin identity's user. The CEO agent decides through the plugin; the worker applies the decision with the admin PAT, which no agent ever sees.

**Tools and roles.**

| Tool | Class | Role |
|---|---|---|
| `ado_environment_approval_get` | R | `deploy_approver` (CEO only) |
| `ado_environment_approval_post` | W | `deploy_approver` (CEO only) |
| `ado_release_verdict_post` | W | `reviewer` with a release function in config |

The `_post` suffix on the write tools is deliberate: the host infers risk from the name, and `decide` would be classed read. `deploy_approver` is granted only by `platformAdmin.deployApproval.approverAgentIds` (at most one id) and grants nothing else.

**Configuration** (`platformAdmin.deployApproval`, everything default off):

```
enabled: false
approverAgentIds: [<CEO agent id>]        # exactly 1 when enabled
environments: ["kippiowl-staging"]        # subset of platformAdmin.environments; /prod/i names rejected
deployPipelineIds: [138]                  # at most 3
buildPipelineIds: [140]                   # at most 3
imageRepository: "harbor.alroze.cloud/kippiowl/kippiowl"   # exact, no wildcard
sourceBranch: "refs/heads/main"
releaseVerdictFunctions: { techlead: [ids], qa: [ids], security: [ids] }
```

Validation: the approver may not be an author, reviewer or verdict agent; no agent may hold two release functions; every verdict agent must be a reviewer; `enabled` requires `platformAdmin.enabled` and `identities.admin`.

**Controls (all re-checked live at decision time).**

1. Environment allowlist: the approval is traced through its check configuration to the environment; if it cannot be proven allowlisted, refuse (`resource_not_allowed`). Fail closed.
2. Pending and ours: status pending, exactly one step, assigned to the admin identity.
3. Allowlisted pipeline run: definition in `deployPipelineIds`, in progress, `sourceBranch` exact, reason manual.
4. Binding: strict parse of `imageReference` (repository must equal `imageRepository`), `sourceCommit` (40 hex) and `buildId`; the build must be from `buildPipelineIds`, succeeded, on the same commit.
5. Attestation: the `release_verdict` table must hold, for each of the three functions, a latest vote >= 5 on exactly this tuple, not superseded by a later vote <= -5. A new commit, image or build id is a new tuple; nothing carries over.
6. Requester: `requestedFor`/`requestedBy` differ from the admin identity, and the run traces to an applied `ado_pipeline_run_create` ledger action proposed by a non-CEO agent (`requester_unknown` otherwise).
7. Release issue: resolves, not blocked/cancelled, no unresolved blockers.
8. One decision per approval id: `action` row with key `envapproval:{approvalId}` written before the ADO call; a repeat returns the first outcome; a different decision on a decided approval is refused; a crash-stuck `applying` row is resolved by reading the approval back.
9. Approve only; reject is narrow: reject touches only a pending approval on an allowlisted environment of an allowlisted deploy pipeline, with a required reason; out-of-scope approvals are never touched.
10. Audit: plugin audit log plus a comment on the release issue (approval id, environment, run, pipeline, commit, digest, build id, verdicts, requesters, outcome, deciding agent). No PAT, no tokened URLs.
11. No secrets: the PAT exists only in the worker through `identities.admin`; the scrubber and sentinel-secret tests cover it.
12. Atomicity: the evaluator runs twice, the facts hash must match right before the PATCH, and the approval is read back afterwards; otherwise `postcondition_failed`.

**Threats and answers.**

| Threat | Answer |
|---|---|
| Another agent calls the tool | `deploy_approver` role, CEO id only; config validation |
| CEO approves its own run | ledger trace: proposer must not be the CEO; `requestedFor` check |
| Approval for production or another environment | control 1; `/prod/i` names rejected at config validation |
| Wrong pipeline (141, 140, any) | control 3 |
| Run deploys an unreviewed digest | controls 4–5: tuple must match attestations |
| Image swapped after attestation | tuple includes digest, commit and build id |
| Stale attestation reused next release | tuple-exact, latest per agent |
| Replay or double click | control 8 |
| Prompt injection through issue or PR text | no free text is read; only ADO ids, parameters and the ledger |
| PAT exfiltration | worker-only, scrubber, sentinel test |
| ADO returns an unexpected shape | strict parsers, fail closed |
| Admin PAT used for anything else | only the approvals GET/PATCH and the read GETs of this feature |

**Rollback.** Set `platformAdmin.deployApproval.enabled: false`; all three tools refuse at once (`not_enabled`). Existing `release_verdict` rows and ledger actions are harmless history. The install request (slice 6) lists, definitely:

- Two new migrations: `004_release_verdict.sql` (new `release_verdict` table with a tuple index) and `005_env_approval_status.sql` (extends the `action` status check constraint with `applying`, used by the lease-fenced one-decision ledger).
- One new SDK capability: `issue.relations.read` (required to resolve release-issue blockers, control 7).
- One new config block: `platformAdmin.deployApproval` (everything default off).
- One new role: `deploy_approver` (CEO agent id in `platformAdmin.deployApproval.approverAgentIds`).
- Prerequisite: the CEO tool allowlist must add `ado_environment_approval_get` and `ado_environment_approval_post` — the CEO receives these tools only through the per-agent config (`approverAgentIds`), not through a role profile.

## Library variable groups (0.16.0)

`ado_variable_group_update` follows the platform administration rules above: `platformAdmin.enabled`, default deny, human confirmation, the separate `identities.admin` credential.

**Configuration.** `platformAdmin.variableGroups` lists `{ name, secrets }`. `secrets` maps each allowed secret variable name to a `secret_ref`. The Paperclip secret must differ from every credential the plugin itself holds.

**Flow.** Propose (nothing written) → person approves → apply: re-check the scope, read each bound secret through the host, `POST` (create) or `PUT` (change) the group, read it back. The readback checks names, plain values and the secret flag. Secret values are write-only in Azure DevOps and are not compared.

**Why the secret reference is bound in settings.** An agent that could name any Paperclip secret could push it into a library any pipeline can read. Binding the reference in the settings keeps the choice of secret with the board, and keeps the value out of agent arguments, approval cards, audit rows, logs and results.

**Open check.** Changing an existing group assumes Azure DevOps keeps a secret variable's value when it is resent with `isSecret: true` and no value. Verify on a scratch group before relying on it for groups that already hold secrets.

**Rollback.** Empty `platformAdmin.variableGroups`.

## Staging release bundle (0.17.0)

Design: ALRAA-1780 (v2). One human approval replaces the two pipeline-run cards of a staging release: pipeline 140 (build) on `refs/heads/main` at a pinned commit, then pipeline 138 (deploy) with the digest that 140 published. Not a token: only the plugin worker runs the steps, with fixed arguments.

**Config.** `platformAdmin.deployApproval.releaseBundle` (strict parser, default off, every violation refuses the config): `enabled, projectId, buildPipelineId, deployPipelineId, proposerAgentIds (1..5), approverUserIds (required), ttlMinutes (1..120), proposalTtlMinutes (1..60), maxBuildAttempts (1..2), maxCommitsBehind (0..20), maxProposalsPerAgentPerDay (1..20)`. Proposers are author-role agents that are not reviewers, attestation agents or the deploy approver. The host does not expose the board role of the person who accepts a card, so `approverUserIds` is required.

**Data.** `release_bundle` (migration 006). One open bundle per company and project (unique partial index). The host refuses triggers, so integrity is: CHECK constraints (commit format, branch main, digest format, approval and expiry bounds), a store whose UPDATE statements never name a frozen column (tested by a scan), set-once columns guarded by `WHERE col IS NULL`, and `args_hash` and the config snapshot recomputed from the row at accept and at every step. Residual: someone with raw database write access can edit a frozen column; that actor can already edit the `action` ledger.

**Lifecycle.** `awaiting_confirmation -> active -> building -> built -> deploying -> completed`, with `failed, rejected, expired, revoked` as ends. The accept handler needs a user principal listed in `approverUserIds` and one CAS (`status`, `expires_at > now`, `args_hash`). Each step claims with one CAS (status, window, args hash, config hash, free lease) and writes its intent (`build_attempts`, `step_started_at`) before calling Azure DevOps. 140 runs at most `maxBuildAttempts` times; 138 runs once. A pending 138 is cancelled when the window ends or on revoke; a running one is never cancelled, and the bundle stays `deploying` until it ends.

**Identities.** Queue and cancel: author only. Reads (build facts, runs list, artifacts, commits, approvals): admin. The worker never queues as admin, so control 6(a) still holds.

**Recovery.** A claimed step with no run id after the 2 minute lease lists runs since `step_started_at - 2 min` and adopts exactly one that matches commit, branch, reason, requester, template parameters, variables and resources. Two matches: failed. Zero: 138 fails (never re-queued); 140 waits 5 minutes (listing lag), then returns to `active` once, counted in `build_attempts`.

**Digest.** Only from the `image-provenance` artifact of the pinned build (`image-reference.txt`, `source-commit.txt`, `build-id.txt`, published by `.azure/image-build.yml`). The reference must equal `<imageRepository>@sha256:<64 hex>`; commit and build id must equal the pinned ones. First pin is immutable. No tags, no logs, no registry credential; the Harbor check stays with the attestations.

**Ledger and control 6.** Each queued run writes an `action` row (`ado_pipeline_run_create`, `applied`, `args_redacted.source = 'release_bundle'`, key `bundle:{id}:build:{n}` or `bundle:{id}:deploy`, agent = proposer). Control 6 accepts such a row only while a bundle row in `deploying` or `completed` with an approver backs the exact run (run id, commit, pipeline, digest, proposer). Other readers of `action` look at proposed, awaiting or escalated rows and never see these.

**`ado_pipeline_run_create` is unchanged.** 140 and 138 on `main` stay gated for every caller; only the worker code path queues without a card.

**Rollback.** `enabled: false`: tools refuse (`not_enabled`), the job stops open bundles at their next step and cancels a pending 138. The migration is additive.

**Install request (board action).** One migration (`006_release_bundle.sql`); no new SDK capability; one new job `release-bundle`; one new config block (default off); three new tools; 51 tools in total. The flag stays off after install.

**Checks that need a real server (not covered by the fake).** The artifact download route (Container artifact via `resources/Containers`), the direction of `diffs/commits` counts, `pipelines/approvals` plus timeline for "pending at the environment approval", and that pipeline 140 is `.azure/image-build.yml`.
