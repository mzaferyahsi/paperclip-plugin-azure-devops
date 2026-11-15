# Changelog

## 0.17.0

- Staging release bundle approval (ALRAA-1780 design v2, ALRAA-1785). New tools `ado_release_bundle_create` (gated, author-role proposers), `ado_release_bundle_get` (read) and `ado_release_bundle_revoke_apply` (write, narrowing only). One human-only card replaces the two pipeline-run cards for pipeline 140 (build) and 138 (deploy); the environment approval and the three attestations are unchanged.
- New job `release-bundle` (every minute) runs the steps with the author identity only and reads with the admin identity. Every step is one compare-and-set on the bundle row (status, window, argument hash, config hash, lease). Crash recovery adopts a run only on an exact match of commit, branch, reason, requester, parameters, variables and resources; a deploy run is never queued twice.
- The digest comes only from the `image-provenance` build artifact of the pinned build (repository, commit and build id are checked). Tags and logs are never read. No registry credential.
- `ado_pipeline_run_create` is unchanged: 140 and 138 on `main` stay gated for every caller. Deploy approval control 6 accepts a bundle ledger row only while an approved bundle row backs that exact run.
- Migration `006_release_bundle.sql` (additive). Config block `platformAdmin.deployApproval.releaseBundle`, default off; every violation refuses the config. Settings card "Staging release bundle". Tool count is now 51 (the README said 47, the manifest had 48).
- Deviation from the design: the host refuses `CREATE TRIGGER` in plugin migrations, so the freeze trigger is replaced by CHECK constraints plus a store that never names a frozen column (tested). No transactions either: bundle row and ledger row are two ordered idempotent writes and every tick repairs a missing ledger row.

## 0.16.1

- Settings page: new "Library variable groups" card (Pipelines panel). It holds the platform administration switch, the allowlist of group names and, per group, the secret variables with the Paperclip secret behind each one.

## 0.16.0

- New gated tool `ado_variable_group_update`: create or change one allowlisted Library variable group. Two phases, confirmed by a person (approver agents cannot decide it).
- Plain variables carry their value, which is shown on the approval card. Secret variables are named only: the value comes from the Paperclip secret bound to that variable in `platformAdmin.variableGroups[].secrets`, is read at apply time, written as a secret variable and never stored, logged, audited or returned. Agents cannot choose which secret is used.
- Guards: group allowlist (exact names), credential-looking names refused as plain variables, a secret variable can never be turned into a plain one, nothing is deleted, variables not listed are left alone, a secret may not reuse one of the plugin's own credentials, readback verifies names, plain values and the secret flag.
- Off unless `platformAdmin.enabled` and a group is listed. No new host capability: upgrades in place.

## 0.15.1

- Approver lookup: ask the identities API for the Account and Mail properties explicitly, and also accept a single-candidate match on the display name when ADO stores a Microsoft account as `name domain` without an Account property (seen for primroseyahsi@gmail.com). The not_an_ado_identity error now reports how many candidates came back and how many matched. Still requires exactly one active, non-group, non-plugin identity.

## 0.15.0

- Governed staging deploy approval (ALRAA-1280, slices 1–5). New tools `ado_environment_approval_get` (read) and `ado_environment_approval_post` (write) for the `deploy_approver` role (the single agent listed in `platformAdmin.deployApproval.approverAgentIds`) and `ado_release_verdict_post` (write) for reviewers with a configured release function (TechLead, QA, SecurityEng). The CEO decides the `kippiowl-staging` environment Approval check through the plugin; the worker applies the decision with the admin PAT, which agents never see. Every control is re-evaluated live before and immediately before the decision: allowlisted environment (resolved through the check configuration, fail closed), pending approval assigned to the admin identity, allowlisted deploy pipeline run on the exact source branch with a manual requester, strict `imageReference`/`sourceCommit`/`buildId` parameter binding, a succeeded build from an allowlisted build pipeline on the same commit, tuple-exact release attestations from all three reviewer functions, a release issue that is open and unblocked, a ledger trace of the run to a non-CEO proposer, and one decision per approval id (a repeat returns the first outcome; a different decision is refused). Approve is the only path that lets a pipeline continue; reject is narrow and never touches anything out of scope. Everything is audited without secrets; `release_verdict` is a new migration. Everything is off until `platformAdmin.deployApproval.enabled` is set; see `docs/architecture.md` for controls, config, threat table and rollback. No installation, enablement or pipeline change is part of this release; pipeline 141 stays disabled.

## 0.14.0

- Merges the organisation's platform administration work (branch feat/platform-admin, its own "0.13.0") with 0.13.x. It adds scoped environment and secure-file read tools, a human-gated secure-file pipeline grant and a human-gated Approval check on allowlisted environments. Off unless `platformAdmin` is enabled and `identities.admin` is bound.
- Keeps `ado_pr_policy_queue_apply` and the `inspect-*` board actions, which the branch predated. Installing the branch alone would have dropped them.

## 0.13.3

- New board action `inspect-build` (read only): the steps of a build with their results and the log tail of failed steps. Needs projectId and buildId.

## 0.13.2

- `inspect-pr-policy` with `commit` and `yamlFull: true` also returns the pipeline YAML text (first 20 KB). Board only, read only.

## 0.13.1

- Board action `inspect-pr-policy` accepts an optional `commit` (40 hex) and then also returns the pool lines of the pipeline YAML at that commit (`yamlPool`), so the board can see where a policy run would really go. Read only.

## 0.13.0

- New tool `ado_pr_policy_queue_apply` (operator role, gated): queues the Build policy of a pull request on its head, like the Queue button for manual-queue-only policies. Until now only a board action could do this, so agents had no supported way and fell back to generic pipeline runs, which are not linked to the policy. Two phases like `ado_pipeline_run_create`: the approval (a person on the issue, or an approver agent when approvers decide) is bound to the head commit and the Build policy evaluations, a used request is spent so a new attempt needs a new approval, and replaying an action queues nothing. It changes no policy, vote or merge.

## 0.12.1

- Fix: the opencode tool server refused every call with "no project" in runs woken by the heartbeat timer, because such runs carry no task. It now finds a project step by step: project id, the run's task, the agent's own in-progress, todo or blocked issue, then any project of the company. The host only needs a project of the company for the run context. The command-line helper got the same fallback.

## 0.12.0

- New setting **Agent tools: install the Azure DevOps tools for opencode agents** (Settings, Pipelines tab). Paperclip gives plugin tools only to some adapters, so agents on `opencode_local` had none. When on, the plugin installs a small stdio MCP server (`azdo`) next to the opencode config of every agent that holds a role, adds it to that config with an `azdo_*` allow, and keeps it current every minute. Turning the setting off removes it. The tools appear as `azdo_ado_pr_get` and so on and call the same tools through the host with the run's own credentials, so roles, approvals and audit are unchanged. Other config entries are never touched; a backup `opencode.json.bak-azdo` is kept.

## 0.11.14

- Fix: a new `ado_pipeline_run_create` proposal (no `actionId`) after an identical run was already applied now creates a fresh action with its own approval. Before, it returned the old "Already applied" action. A pending identical attempt is still reused, replaying an applied `actionId` still queues nothing, and the rejection cooldown, expiry, commit and input binding and apply locking are unchanged. Other tools keep "Already applied". On equal timestamps an applied row no longer masks a pending one.
- Documented the difference between proposing a new attempt and checking or replaying an action (tool description and skill).

## 0.11.13

- The plugin closes the "Approve: ..." task it creates once the action has left the approvers' hands (done; cancelled if it expired with no decision). Before, nothing closed it and it stayed in progress. The same job closes older stuck ones.

## 0.11.12

- Fix: a tool that needs an issue (protected pipeline run, definition and repository changes, links, commits) now uses the issue the heartbeat run has checked out. Before, it used the agent's only in-progress issue, so an agent with two in-progress issues got `no_issue_for_confirmation`.
- `ado_pipeline_run_create` takes an optional `issueId` (must be in progress and assigned to the caller).

## 0.11.11

- The refusal for `ado_pr_gate_post` now says that QA and Security verdicts use `ado_pr_review_post`, so agents do not ask for a gate role they do not need.

## 0.11.10

- Fix: the saved list of allowed pipeline queues was cut to its first 20 entries, so queues added later (for example Default, id 1) were refused with queue_not_allowed. The limit is now 200.

## 0.11.9

- Board action `refresh-reviewer-vote`: sets the reviewer bot vote to 0 and back, so Azure DevOps evaluates a stale Minimum-reviewers policy again.

## 0.11.8

- `inspect-pr-policy` can list the latest pushes to a branch (`repositoryId`, `refName`) to check last-pusher rules.

## 0.11.7

- `inspect-pr-policy` also shows the reviewer-policy settings (minimum approvers, creator vote, last-pusher vote, reset on push).

## 0.11.6

- Board action `requeue-pr-policy` accepts an optional `evaluationId` to re-queue any one policy (for example a stuck Minimum number of reviewers), not only Build policies.

## 0.11.5
- A Build policy that stays "queued" with no build on the head (for example because its pipeline was disabled when the pull request opened) is now evaluated again by the reconciler: when the same head shows it on two looks at least 8 minutes apart, once per policy, head and hour. Azure DevOps then queues the policy's own validation build on the unchanged head, so reviews stay valid. Nobody has to ask for it or merge by hand in the portal.

## 0.11.4
- Protected pipeline runs are decided by approver agents when the approval mode uses them (setting `approval.pipelineRunsByApprovers`, default on; Merge approval tab, Rules). Before, they always went to a person, whatever the mode. The proposer must give a reason; the proposer cannot decide; with no other approver the board gets the card. `ado_pr_approval_get` takes an `actionId` of a run and shows project, pipeline, branch, reason and proposer. Abandoning a pull request still needs a person.

## 0.11.3
- An approver may also be a reviewer or a staging gate agent. The blanket settings errors are gone. Separation of duties stays per pull request: an approver is refused on a pull request they opened or proposed, on a commit they gave a verdict on, and now also on a commit whose staging gate result they posted. Such an approver is left out of the eligible approvers, so the board decides when nobody else is eligible.

## 0.11.2
- An agent may now be both an approver and an author (for example the CEO). The blanket settings error is gone; the per pull request rule stays: an approver is refused on any pull request they opened or proposed, and cannot give a verdict. When that leaves no approver, the board gets the card (0.11.1).

## 0.11.1
- Merge approval: when no configured approver may decide a pull request (the approver authored it, proposed it or gave a verdict), the plugin no longer waits for an approver that cannot act. It puts the board's confirmation card on the issue at once, and approving that card merges the pull request. Verdicts, build policy and staging gate are checked first. Setting `approval.boardWhenNoApprover` (default on; Merge approval tab, Rules).

## 0.11.0
- Settings page redesigned. Seven tabs (Overview, Connection, Agents and access, Merge approval, Pipelines, Webhooks and limits, Tools) replace one long page with an "Advanced" fold. One agents table (a row per agent, a column per duty) replaces the separate author, reviewer, operator, approver, QA, Security and staging-gate checklists; author and reviewer exclude each other and a verdict makes the agent a reviewer. Merge approval is a three-way choice with a plain explanation, then rules in plain cards. A sticky bar shows unsaved changes with Save and Discard, and the browser warns before leaving with unsaved changes. Status tiles replace the one-line status. No setting changed meaning and no migration.

## 0.10.2
- Fix: a person's approval of a confirmation card failed with a generic tool error when their Paperclip user id was not a UUID (the approver column was typed uuid). Migration 003 stores it as text. Settings queue labels show the project; board actions `inspect-pr-policy` (read-only policy and pipeline diagnosis) and organization pool listing in `discover-queues`.

## 0.10.1
- Settings: agent queues, repositories with a staging gate and repositories that need no pipeline are picked from lists (loaded from Azure DevOps) instead of typed as ids or names. New action `discover-queues`.

## 0.10.0
- Agents no longer need a PAT or az: 12 read tools (repository files and trees, branches, pipelines, runs by commit, branch policies, pipeline preview, resource access, service connections, variable group names, agent queues, identity permissions), log tail by task, and runs pinned to an exact commit.
- Gated tools `ado_pipeline_create`, `ado_pipeline_update` and `ado_repo_create` (off by default; a person confirms; pipelines are created disabled). 36 tools.

## 0.9.7
- Operators (for example a Tech Lead who pushes fixes) can publish or un-draft a pull request with `ado_pr_update`; for them only the draft state may change. Authors keep full update rights on pull requests the plugin opened.

## 0.9.6
- `approval.pipelineOptionalRepositories`: repositories with no pipeline (a handbook) do not need an approved Build policy for the approval check. `scripts/upgrade-live.sh` upgrades and re-enables the plugin.

## 0.9.5
- Hand-opened pull requests are manageable in the organisation: an author agent whose issue it is linked to can publish or un-draft it (only the draft state), the new setting "Allow pull requests opened by hand with no recorded author agent" lets them be reviewed and approved, and adoption (`author: true`) stays available.

## 0.9.4
- Pull requests opened by hand can be adopted: `ado_link_create` with `author: true` records the calling author agent (once, on its own issue); then `ado_pr_update` and the approval flow work.

## 0.9.3
- `ado_pr_get` and the other pull request results now include `headCommit`, so reviewers can confirm the exact commit they reviewed.
- Agent guide: open pull requests with `ado_pr_create`; hand-opened and draft pull requests cannot be reviewed or approved through the plugin.

## 0.9.2
- An approver who tries to propose a completion is told to ask an operator or the author, not the board.

## 0.9.1
- Review status: the newest status on the iteration decides. Azure DevOps lists every status that was posted, so the old pending one could win over the later succeeded one and keep merges blocked as not_ready.

## 0.9.0
- Review round on the approval feature: the merge is of the approved commit only; a Build policy (not just a status policy) must be approved; approvers are woken; approvers cannot be authors, reviewers or gate agents; one agent cannot hold two verdict functions; approvers mode applies to completing pull requests, while abandon and protected pipeline runs stay with a person; one apply per action; settle retries transient failures.
- Merge approval inside the organisation: `approval.mode` board, approvers or both. Approver agents decide with `ado_pr_approval_post` after the plugin has verified verdicts per function on the exact head commit, a blocking pipeline policy, no active review threads, a staging gate (per repository) and separation of duties; `ado_pr_approval_get` shows the facts. Silent approvers escalate to the board after a deadline.
- New tools `ado_pr_approval_get`, `ado_pr_approval_post`, `ado_pr_gate_post` (21 in total); `ado_pr_complete_apply` may also be proposed by the pull request's author in approver mode.
- New capability `issues.create` (approval tasks). Migration 002.

## 0.8.0
- Security: confirmation cards for gated actions are now human-only, and a card an agent accepted is refused (the host lets any agent with a run resolve a card unless told otherwise).
- With several projects configured, the project is inferred from a repository name that exists in only one; otherwise the error names the candidates.
- The same run repeating the same comment or review is acknowledged once instead of posting twice.

## 0.7.0
- Host: `--root` installer option, legacy `<org>.visualstudio.com` hosts get the brokered credential too, installer test switch.
- Tests run on plain CI: own embedded Postgres devDependencies, installer and wrapper tests, wizard logic moved into testable functions, neutral fixtures.

## 0.6.1
- Review fixes: webhook values shown whichever is newly created, reused-PAT notice, PAT scope list completed, tool calls per run field in Advanced settings, failed config loads count against the run quota, safer `--uninstall`, test that other hosts keep their credential helpers.

## 0.6.0
- Setup panel supports personal access tokens as well as Entra service principals; the tenant can be typed when it cannot be detected.
- Webhook password and header value are shown once when created, so the service hook can actually be configured.
- New setting `limits.maxToolCallsPerRun` (default 60). Issue keys may have 2 to 10 letters or digits.
- A reused secret is reported as such.

## 0.5.0
- Public documentation: setup guide, architecture, honest note on what the git token can do.
- Host install is portable: pins the real git and node it finds, `#!/usr/bin/env node` helper, `PAPERCLIP_ADO_ROOT` override.
- Removed config fields nothing used (`webhook.manageSubscriptions`, `allowlists`) and misleading UI text.
- Internal QA tooling and design notes moved out of the repository.

## 0.4.3
- Git wrapper no longer clears credential helpers for other hosts: GitHub (and anything else) keeps its own login; only dev.azure.com is brokered.

## 0.4.2
- Removed the dev-only spike-git-auth action; git-access-test remains.

## 0.4.1
- Writing the git PATH into the default environment passes the company context Paperclip requires for environment variables.

## 0.4.0
- Works for every agent, like GitHub: tool access is one company-wide profile by default (the plugin still enforces author, reviewer and operator roles), and the git wrapper goes into the default execution environment, so every run of every agent and every project, including ones created later, gets it. Per-role profiles stay available.
- New setting `roles.everyoneIsAuthor`: every agent that is not a reviewer is an author (author token, can push and open pull requests), including agents added later.

## 0.3.0
- Git without SSH keys: a credential broker route (`POST /api/plugins/<key>/api/git/credentials`, agent auth) hands the run's own bot token to a host credential helper, so stock `git clone/fetch/push` works in agent runs. Authors get the author bot, everyone else the reviewer bot. Scope, run liveness, rate limit and audit are enforced by the plugin.
- `host/` holds the root-owned git wrapper, the credential helper and `install-git-access.sh` (one command, sudo, reversible).
- Setup wizard: a Git access step (install command, coverage of selected projects, one click to put the wrapper first on the PATH of Paperclip projects, test, usage counters).
- New capability `api.routes.register`; core table `heartbeat_runs` is read to check that the requesting run is alive.

## 0.2.0
- Guided setup on the settings page: paste the organization URL (tenant detected from Azure DevOps itself), use the azure-devops/* secrets you already created or paste the two service principals once, find projects, suggest agent roles, give agents exactly their tools (tool profiles created and bound for you), turn on chips, check permissions with fix links, prepare webhook secrets. One button runs everything that needs no decision.
- Advanced settings stay available below the wizard.

## 0.1.5
- Connection test checks each bot's Git permissions (contribute to pull requests, bypass, edit policies, push) and warns about missing or excessive rights.

## 0.1.4
- The review status is only published on pull requests linked to a Paperclip issue, so unrelated pull requests in the same repositories get no status.

## 0.1.3
- The Entra client id can be a Paperclip secret (`clientIdRef`).
- A company can save its identities before choosing projects (needed for project discovery).

## 0.1.2 (after independent review)
- Gated completion re-validates every approved attribute on the live pull request (target branch, votes, review status, policies, draft) before applying; phase 2 ignores any argument sent again.
- Protected pipeline runs bind the project into the approval.
- Approved gated actions are applied by the plugin itself; rejected proposals have a 30 minute cool-down and no longer create a card per retry.
- PATs are read from the host once per five minutes; host secret rate limits back off instead of failing calls.
- Repository and project scope are enforced on webhooks, reconcile, links, chips and work items.
- A review no longer loses its status to a pending reset; a first-seen pull request keeps an existing review status.
- Only the assignee or an operator can bind an issue by id; no comments on done issues; webhook routing is cached; short or empty hook secrets authenticate nothing; reconcile budget is exact.
- Tests run every SQL statement through the real host guard.

## 0.1.1
- Issue panel also registers as a `taskDetailView` so it shows in the current Paperclip issue layout.
- Unreadable or private issues no longer fail a sync.

## 0.1.0
- First version: chips for pull requests and work items, webhook inbox and reconciler, link store, 18 agent tools, gated actions with a confirmation ledger, review status, settings page, issue panel and dashboard widget.
