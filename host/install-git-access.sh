#!/bin/bash
# One-time host install (run with sudo). Puts the git wrapper and credential helper in a root-owned directory and records which
# organization/projects old SSH remotes may be rewritten for. Safe to run again. Remove with: sudo ./install-git-access.sh --uninstall
set -euo pipefail
ROOT="${PAPERCLIP_ADO_ROOT:-/opt/paperclip-ado}"
here="$(cd "$(dirname "$0")" && pwd)"
if [ "${1:-}" = "--root" ]; then ROOT="${2:?--root needs a directory}"; shift 2; fi
if [ "${1:-}" = "--uninstall" ]; then [ -f "$ROOT/etc/installed-at" ] || { echo "$ROOT does not look like an install of this tool; refusing to remove it" >&2; exit 1; }; rm -rf "$ROOT"; echo "removed $ROOT"; exit 0; fi
OWN="-o root -g root"
# PAPERCLIP_ADO_TEST_NONROOT is for the test suite only: it installs into a temp directory without root ownership.
if [ -n "${PAPERCLIP_ADO_TEST_NONROOT:-}" ]; then OWN=""; elif [ "$(id -u)" != 0 ]; then echo "run with sudo" >&2; exit 1; fi
org=""; projects=""
while [ $# -gt 0 ]; do case "$1" in --root) ROOT="$2"; shift 2;; --org) org="$2"; shift 2;; --projects) projects="$2"; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
[ -n "$org" ] && [ -n "$projects" ] || { echo "usage: sudo $0 --org <organization> --projects <project1,project2>" >&2; exit 2; }
[[ "$org" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,49}$ ]] || { echo "invalid organization" >&2; exit 2; }
install -d -m 755 $OWN "$ROOT" "$ROOT/bin" "$ROOT/etc"
install -m 755 $OWN "$here/git" "$ROOT/bin/git"
install -m 755 $OWN "$here/git-credential-paperclip-ado" "$ROOT/bin/git-credential-paperclip-ado"
# Pin the real git (not an earlier wrapper or shim) and node, so runs do not depend on an agent PATH.
real=""
IFS=: read -ra dirs <<< "$PATH"
for d in "${dirs[@]}"; do c="$d/git"; [ -x "$c" ] || continue; [ "$(readlink -f "$c")" = "$(readlink -f "$here/git")" ] && continue; case "$(readlink -f "$c")" in "$ROOT"/*) continue;; esac; head -c2 "$c" | grep -q '^#!' && continue; real="$(readlink -f "$c")"; break; done
[ -n "$real" ] || { echo "no real git binary found on PATH; install git first" >&2; exit 1; }
nodebin="$(command -v node || true)"; [ -n "$nodebin" ] || { echo "node (>= 18) is required on PATH for the credential helper" >&2; exit 1; }
nodebin="$(readlink -f "$nodebin")"; sed -i "1s|.*|#!$nodebin|" "$ROOT/bin/git-credential-paperclip-ado"
install -m 644 $OWN /dev/null "$ROOT/etc/real-git"; printf '%s\n' "$real" > "$ROOT/etc/real-git"
tmp="$(mktemp)"; : > "$tmp"
IFS=',' read -ra ps <<< "$projects"
for p in "${ps[@]}"; do p="$(echo "$p" | sed 's/^ *//;s/ *$//')"; [[ "$p" =~ ^[^/[:cntrl:]]{1,256}$ ]] || { echo "invalid project name: $p" >&2; exit 2; }; echo "$org/$p" >> "$tmp"; done
install -m 644 $OWN "$tmp" "$ROOT/etc/git-access.conf"; rm -f "$tmp"
printf '%s\n' "$(date -u +%FT%TZ)" > "$ROOT/etc/installed-at"; chmod 644 "$ROOT/etc/installed-at"
"$ROOT/bin/git" --version >/dev/null
echo "installed in $ROOT (org $org, projects $projects, git $real)"
