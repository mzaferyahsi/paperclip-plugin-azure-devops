# Setup guide

Plan for about 30 minutes if you already have admin rights in Azure DevOps and Microsoft Entra. Steps 1 to 3 happen outside Paperclip; the rest is the in-product setup panel.

## 0. Requirements

- Paperclip 2026.1012.0 or newer, with permission to install plugins and to change **Instance settings > Experimental**.
- An Azure DevOps organization, and rights to add users and change project permissions.
- For agent git access: a Linux host with `git` and `node` (18 or newer), and one `sudo` run. The installer pins the git and node it finds on root's PATH; if node comes from nvm, Volta or similar, run `sudo env "PATH=$PATH" host/install-git-access.sh ...`. macOS is untested. Not available inside containers where you cannot run a one-time root install.

## 1. Create two identities (Entra service principals)

The plugin uses two separate identities so that the author of a pull request can never be the one who approves it.

1. In the Entra portal, **App registrations > New registration**. Create `paperclip-author` and `paperclip-reviewer` (single tenant). Note each **Application (client) ID** and the **Directory (tenant) ID**.
2. For each app, **Certificates & secrets > New client secret**. Copy the secret value once.
3. In Azure DevOps, **Organization settings > Users > Add users**: add both service principals with access level **Basic**.

No Entra access? In the setup panel choose **Personal access tokens** and paste one PAT per bot account (two different accounts). Scopes: Code (read, write and status), Pull Request Threads, Work Items (read and write), Build (read and execute), Project and Team (read). A PAT belongs to a person and expires, so a service principal is better when you can have one; with a PAT the git token handed to agents is the PAT itself.

## 2. Give the identities access

In each project agents may use, **Project settings > Permissions**: put `paperclip-author` in a group that can **Contribute** and **Create branch**, and **Contribute to pull requests**. The reviewer needs **Read** and **Contribute to pull requests** only; if it can also push, the setup panel warns you. Never grant bypass or policy-edit rights; the plugin never uses them.

## 3. Turn on link chips (optional but recommended)

Paperclip **Instance settings > Experimental > External objects**. Without it, links to pull requests stay plain text.

## 4. Install the plugin

```
npm run build                      # in a clone of this repository
paperclipai plugin install --local /path/to/paperclip-plugin-azure-devops
```

Upgrade with `paperclipai plugin upgrade mzaferyahsi.azure-devops` after building. A release that asks for new capabilities needs an uninstall and install (the host refuses silent capability growth); settings and tables are kept.

## 5. The setup panel

Open the company settings, **Azure DevOps**. Work top to bottom; "Set up everything I can" does every step that needs no decision.

1. **Organization.** Paste the organization URL; the tenant id is read from Azure DevOps.
2. **Connect the two identities.** Paste each client id and secret once; they are stored as Paperclip secrets named `azure-devops/...`. Existing secrets with those names are reused and the panel says so.
3. **Projects.** Tick the projects agents may use.
4. **Roles.** Review the suggested authors, reviewers and operators.
5. **Agent tools.** "Give agents their tools" creates one company-wide tool profile. Roles are enforced by the plugin.
6. **Check permissions.** Shows what each identity can do and links to the Azure DevOps pages that fix any gap.
7. **Git without SSH keys.** Run the one command the panel prints:
   ```
   sudo host/install-git-access.sh --org <organization> --projects <project1,project2>
   ```
   then click "Apply to all runs". Re-run the command whenever you add projects. Agents then use plain `git clone/fetch/push` over HTTPS with no key on disk. Other hosts such as GitHub are unaffected.
8. **Webhooks (optional).** Without them a reconciler keeps state current within minutes. To get instant wake-ups, create service hooks with the recipe the panel shows.

## 6. Optional hardening

- Make the `paperclip/review` status a required **Status policy** on protected branches, so a merge needs the independent reviewer's verdict. Note that it also applies to pull requests nobody linked to a Paperclip issue; scope the policy to branch patterns agents use if people also work there.
- Add an edge rate limit for the public webhook route.

## Settings you may want to change

| Setting | Default | Meaning |
| --- | --- | --- |
| `limits.maxToolCallsPerRun` | 60 | Azure DevOps tool calls one agent run may make (5 to 1000). Set it on the "Webhooks and limits" tab, "Tool calls per run". |
| `links.branchPattern` | `<agent>/<ISSUE-KEY>-<topic>` | How a branch name finds its issue. Keys are 2 to 10 letters or digits, then a dash and a number. |
| `reconcile.*` | 10 min active, 6 h dormant | How often open pull requests are re-read. |
| `roles.everyoneIsAuthor` | off | Every agent that is not a reviewer may open pull requests and push. |

The webhook password and header value are shown once when the panel creates them. Copy them into the service hook then; to rotate, delete the two `azure-devops/webhook-*` secrets and prepare again.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Test connection: 401 or 403 | Wrong secret, expired secret, or the service principal has no organization seat. |
| Git: "outside the selected projects" | The project is not ticked in the settings. |
| Git: "no Paperclip run identity" | You ran git outside an agent run. |
| Agents do not see `ado_*` tools | The tool profile is not applied (step 5). |
| Links are not chips | External objects flag is off. |
| New agent cannot push | It is not an author; tick it, or use "Every agent is an author". |

Uninstall: `paperclipai plugin uninstall mzaferyahsi.azure-devops`, and `sudo host/install-git-access.sh --uninstall`.
