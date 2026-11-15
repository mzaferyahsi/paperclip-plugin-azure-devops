# Host side of git access

`install-git-access.sh` (run once with sudo) puts these in `/opt/paperclip-ado` (root-owned):

- `bin/git`: runs the real git with `-c` credential helper settings for `dev.azure.com`, `useHttpPath=true`, and rewrites old `git@ssh.dev.azure.com:v3/<org>/<project>/` remotes to HTTPS for the listed projects. `-c` settings win over the system and user git config that managed Paperclip runs switch off.
- `bin/git-credential-paperclip-ado`: asks the plugin (`POST /api/plugins/mzaferyahsi.azure-devops/api/git/credentials`) for a token with the run's `PAPERCLIP_API_KEY`. Nothing is stored; `store` and `erase` do nothing.
- `etc/git-access.conf`: `<org>/<project>` per line.
- `etc/real-git`: the real git binary found at install time (the wrapper falls back to `/usr/bin/git`). The installer also pins the `node` it finds into the helper's first line. Run it with `sudo env "PATH=$PATH" ...` if node comes from nvm or Volta.

Use `--root <dir>` to install somewhere other than `/opt/paperclip-ado`, and set `PAPERCLIP_ADO_ROOT=<dir>` for the wrapper. `--uninstall` refuses to delete a directory without `etc/installed-at`.

Paperclip puts `/opt/paperclip-ado/bin` first on the PATH of the default execution environment (setup wizard, Git access step). Remove everything with `sudo install-git-access.sh --uninstall`; agents then lose git access to Azure DevOps and the PATH entry is harmless.

Paperclip's own project workspace refresh still runs with the server's git configuration, not through this wrapper.
