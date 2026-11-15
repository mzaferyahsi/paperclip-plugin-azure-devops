#!/bin/bash
# Upgrade the installed plugin and make sure it comes back healthy. Some Paperclip versions leave it in "error: Worker already
# registered" right after an upgrade; enabling it again is the documented fix.
set -euo pipefail
KEY=mzaferyahsi.azure-devops
npm run build >/dev/null
paperclipai plugin upgrade "$KEY" | grep -m1 '"version"' || true
sleep 6
if ! paperclipai plugin list | grep "$KEY" | grep -q 'status=ready'; then paperclipai plugin enable "$KEY" >/dev/null; sleep 6; fi
paperclipai plugin list | grep "$KEY"
