#!/usr/bin/env bash
# HazeHub launcher (macOS / Linux)
#
# The counterpart to start.ps1. Starts the backend (FastAPI) and the frontend
# (Next.js).
#
#   ./start.sh              # use whatever backend/.env is configured for
#   ./start.sh --emulator   # also start the local Firestore emulator
#
# Where the PowerShell version opens a window per process, this runs them as
# background jobs of one shell and prints their output together. That is the
# normal shape on a Unix terminal, and it means one Ctrl+C stops everything
# instead of leaving orphaned servers holding ports 8000 and 3000.
#
# Datastore resolution (see backend/app/cache.py):
#   FIRESTORE_EMULATOR_HOST set -> the local emulator
#   FIREBASE_PROJECT_ID set     -> real Cloud Firestore
#   neither                     -> a JSON file in backend/data/ (dev only)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -t 1 ]; then
    CYAN=$'\033[36m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
    MAGENTA=$'\033[35m'; RESET=$'\033[0m'
else
    CYAN=""; GREEN=""; YELLOW=""; MAGENTA=""; RESET=""
fi
say() { printf '%s%s%s\n' "$1" "$2" "$RESET"; }

EMULATOR=0
for arg in "$@"; do
    case "$arg" in
        --emulator|-Emulator) EMULATOR=1 ;;
        -h|--help)
            sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            echo "Usage: ./start.sh [--emulator]" >&2
            exit 1
            ;;
    esac
done

if [ ! -d "$ROOT/backend/.venv" ]; then
    say "$YELLOW" "First run detected - running setup..."
    "$ROOT/setup.sh"
fi

PYTHON="$ROOT/backend/.venv/bin/python"

say "$MAGENTA" $'\nStarting HazeHub...'

# --- Shut everything down together -------------------------------------------
# Without this, Ctrl+C kills the foreground `wait` and leaves uvicorn and next
# still bound to their ports, so the next run fails with "address in use".
PIDS=()
cleanup() {
    trap - INT TERM EXIT
    say "$YELLOW" $'\nStopping HazeHub...'
    for pid in "${PIDS[@]:-}"; do
        # Kill the whole process group: `npm run dev` spawns next-server as a
        # child, and killing only npm would orphan it.
        kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

start_bg() {
    # setsid, when available, gives each server its own process group so the
    # cleanup above can take its children with it. macOS has no setsid, and
    # the plain fallback is fine there.
    if command -v setsid >/dev/null 2>&1; then
        setsid "$@" &
    else
        "$@" &
    fi
    PIDS+=("$!")
}

# --- Optional Firestore emulator ---------------------------------------------
if [ "$EMULATOR" -eq 1 ]; then
    if ! command -v firebase >/dev/null 2>&1; then
        say "$YELLOW" "firebase CLI not found. Run: npm install -g firebase-tools  (needs a JDK 21+)"
        exit 1
    fi
    say "$CYAN" "  Firestore emulator -> http://localhost:8080 (UI at :4000)"
    cd "$ROOT"
    start_bg firebase emulators:start --only firestore --project hazehub-local
    export FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
    export FIREBASE_PROJECT_ID="hazehub-local"
    sleep 6
fi

say "$CYAN" "  Backend  -> http://localhost:8000  (API + docs at /docs)"
say "$CYAN" "  Frontend -> http://localhost:3000"

cd "$ROOT/backend"
start_bg "$PYTHON" -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

cd "$ROOT/frontend"
start_bg npm run dev

cd "$ROOT"
sleep 2
say "$GREEN" $'\nBoth servers are running. Open http://localhost:3000 in your browser.'
say "$GREEN" "Sign in with one of the team's accounts, listed in passwords.txt."
say "$GREEN" "Check http://localhost:8000/api/health to confirm which datastore is in use."
say "$YELLOW" "Press Ctrl+C to stop both."

# Hold the terminal open until a server exits or the user interrupts.
wait
