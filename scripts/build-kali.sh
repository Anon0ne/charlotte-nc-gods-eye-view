#!/usr/bin/env bash
# Build and run the Charlotte-enhanced checkout on Kali/Debian/Linux.
set -euo pipefail
TASK_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$TASK_ROOT"
TASK_MODE="${1:-}"
case "$TASK_MODE" in
  ''|--build-only|--run-only) ;;
  *) printf 'Usage: bash scripts/build-kali.sh [--build-only|--run-only]\n' >&2; exit 2 ;;
esac
command -v node >/dev/null && command -v npm >/dev/null || {
  printf 'Install Node.js 24.14+ (24.x) or 26.x and npm, then run this script again.\n' >&2
  exit 1
}
node --input-type=module - <<'JS'
const [major,minor]=process.versions.node.split('.').map(Number);
if (!((major===24 && minor>=14) || major===26)) {
  console.error('This project requires Node.js 24.14+ (24.x) or 26.x. Current: '+process.versions.node);
  process.exit(1);
}
JS
if [[ "$TASK_MODE" != '--run-only' ]]; then
  printf 'Installing locked dependencies...\n'
  npm ci
  printf 'Building the application...\n'
  npm run build
fi
if [[ "$TASK_MODE" == '--build-only' ]]; then
  printf 'Build ready in dist/. Start with: bash scripts/build-kali.sh --run-only\n'
  exit 0
fi
[[ -d node_modules && -f dist/index.html ]] || {
  printf 'Run bash scripts/build-kali.sh first to install and build.\n' >&2
  exit 1
}
# Vite reads the key from the dotenv files; never source these as shell code.
if ! node --input-type=module - <<'JS'
import {loadEnv} from 'vite';
process.exit((process.env.NCDOT_API_KEY || loadEnv('production',process.cwd(),'').NCDOT_API_KEY) ? 0 : 1);
JS
then
  if [[ -t 0 ]]; then
    printf 'DriveNC key (hidden; Enter skips NCDOT layers): '
    IFS= read -r -s TASK_NCDOT_KEY
    printf '\n'
    if [[ -n "$TASK_NCDOT_KEY" ]]; then
      [[ "$TASK_NCDOT_KEY" =~ ^[A-Za-z0-9_-]+$ ]] || { printf 'Unexpected key format.\n' >&2; exit 1; }
      umask 077
      printf '\nNCDOT_API_KEY=%s\n' "$TASK_NCDOT_KEY" >> .env.local
      chmod 600 .env.local
      unset TASK_NCDOT_KEY
    fi
  else
    printf 'NCDOT_API_KEY is not configured; CMPD and CDOT can still run.\n'
  fi
fi
printf '\nOpen http://127.0.0.1:4173 — select Charlotte and enable its layers.\n'
printf 'Press Ctrl+C to stop.\n'
# Keep the backend provider routes: serving dist/ with a plain file server
# would disable CMPD, CDOT, NCDOT, and other proxied feeds.
exec npm run preview -- --host 127.0.0.1 --port 4173 --strictPort
