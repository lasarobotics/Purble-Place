#!/usr/bin/env bash
# HazeHub one-time setup (macOS / Linux)
#
# The counterpart to setup.ps1. Creates the Python venv and installs the
# backend and frontend dependencies.
#
#   ./setup.sh
#
# No database to install: HazeHub stores its data in Cloud Firestore. Until
# you configure a Firebase project (see instructions.txt) it falls back to a
# JSON file in backend/data/ so you can run and click around immediately.

set -euo pipefail

# Resolve the repo root from wherever this was invoked, so the script works
# from any directory. `readlink -f` is GNU only, and macOS does not ship it.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colours, but only when stdout is a terminal: piping this into a log file
# should not fill it with escape codes.
if [ -t 1 ]; then
    CYAN=$'\033[36m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
    MAGENTA=$'\033[35m'; RESET=$'\033[0m'
else
    CYAN=""; GREEN=""; YELLOW=""; MAGENTA=""; RESET=""
fi

say() { printf '%s%s%s\n' "$1" "$2" "$RESET"; }

say "$MAGENTA" $'\n=== HazeHub setup ===\n'

# --- Prerequisites -----------------------------------------------------------
# Checked up front so a missing tool is one clear message rather than a stack
# trace three minutes into a pip install.
missing=0
for tool in python3 npm; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        say "$YELLOW" "  Missing: $tool"
        missing=1
    fi
done
if [ "$missing" -ne 0 ]; then
    echo
    echo "Install the missing tools and run this again."
    echo "  python3   https://www.python.org/downloads/  (or: brew install python)"
    echo "  npm       https://nodejs.org/                (or: brew install node)"
    exit 1
fi

# --- Backend -----------------------------------------------------------------
say "$CYAN" "[1/3] Creating Python virtual environment..."
cd "$ROOT/backend"
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi
PYTHON="$ROOT/backend/.venv/bin/python"

say "$CYAN" "[2/3] Installing backend dependencies..."
"$PYTHON" -m pip install --upgrade pip -q
"$PYTHON" -m pip install -r requirements-dev.txt -q
if [ ! -f ".env" ]; then
    cp .env.example .env
fi

# --- Frontend ----------------------------------------------------------------
say "$CYAN" "[3/3] Installing frontend dependencies..."
cd "$ROOT/frontend"
if [ ! -f ".env.local" ]; then
    cp .env.local.example .env.local
fi
npm install --no-audit --no-fund

# --- Demo data ---------------------------------------------------------------
cd "$ROOT/backend"
say "$CYAN" $'\nSeeding a demo event so every screen has data...'
"$PYTHON" -m app.demo_data

cd "$ROOT"
say "$GREEN" $'\nSetup complete. Run ./start.sh to launch HazeHub.'
say "$GREEN" "Sign in at http://localhost:3000 with one of the team's accounts."
say "$GREEN" "The account list and the shared password are in passwords.txt."
say "$YELLOW" $'\nNext: follow instructions.txt to connect a real Firebase project.'
