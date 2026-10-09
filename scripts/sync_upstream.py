#!/usr/bin/env python3
"""Merge upstream main into a clean main checkout; never force-push."""
import argparse
from pathlib import Path
import subprocess
import sys

UPSTREAM = "https://github.com/lasarobotics/HazeHub-2-.git"
PRESERVE = (
    ".github/workflows/sync-upstream.yml",
    "scripts/sync_upstream.py",
    "scripts/test_sync_upstream.py",
    "UPSTREAM_SYNC.md",
)


def git(*args, check=True):
    result = subprocess.run(["git", *args], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    if check and result.returncode:
        raise RuntimeError(result.stderr.decode(errors="replace").strip())
    return result


def sync(upstream=UPSTREAM, push=False):
    if git("branch", "--show-current").stdout.strip() != b"main":
        raise RuntimeError("Run from the main branch in a clean checkout.")
    if git("status", "--porcelain").stdout.strip():
        raise RuntimeError("Uncommitted files exist. Commit/stash them or use a fresh clone.")
    if git("rev-parse", "--verify", "MERGE_HEAD", check=False).returncode == 0:
        raise RuntimeError("Finish the existing merge first.")

    # Private files are saved before touching upstream, including this script.
    saved = {name: git("show", f"HEAD:{name}").stdout for name in PRESERVE}
    git("fetch", "--no-tags", "origin", "main")
    origin_tip = git("rev-parse", "FETCH_HEAD").stdout.strip()
    git("merge", "--ff-only", "FETCH_HEAD")
    # Capture the latest private versions if another run updated origin.
    saved = {name: git("show", f"HEAD:{name}").stdout for name in PRESERVE}
    git("fetch", "--no-tags", upstream, "refs/heads/main")
    incoming = git("rev-parse", "FETCH_HEAD").stdout.decode().strip()
    if git("merge-base", "--is-ancestor", incoming, "HEAD", check=False).returncode == 0:
        if push and git("rev-parse", "HEAD").stdout.strip() != origin_tip:
            git("push", "origin", "HEAD:refs/heads/main")
            print("Upstream already merged; pushed pending local commits.")
            return True
        print("Already synced; no commit or push needed.")
        return False

    try:
        result = git("merge", "--no-ff", "--no-commit", "--allow-unrelated-histories",
                     "-X", "theirs", incoming, check=False)
        conflicts = git("diff", "--name-only", "--diff-filter=U", "-z").stdout
        if result.returncode and not conflicts:
            raise RuntimeError(result.stderr.decode(errors="replace"))
        # Handle delete/modify and other structural conflicts as well as text.
        # Upstream wins at conflicting paths; private automation is restored below.
        for raw in conflicts.split(b"\0"):
            if not raw:
                continue
            name = raw.decode("utf-8")
            exists = git("cat-file", "-e", f"{incoming}:{name}", check=False).returncode == 0
            if exists:
                git("restore", f"--source={incoming}", "--staged", "--worktree", "--", name)
            else:
                git("rm", "-f", "--ignore-unmatch", "--", name)
        for name, contents in saved.items():
            path = Path(name)
            if path.is_symlink():
                path.unlink()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(contents)
            git("add", "--", name)
        if git("diff", "--name-only", "--diff-filter=U").stdout:
            raise RuntimeError("Unresolved merge conflicts; nothing will be pushed.")
        git("commit", "-m", f"Sync HazeHub-2- main ({incoming[:12]})")
    except Exception:
        git("merge", "--abort", check=False)
        raise
    if push:
        # A concurrent user push rejects this push; the next run retries safely.
        git("push", "origin", "HEAD:refs/heads/main")
    print(f"Synced upstream {incoming[:12]}" + (" and pushed main." if push else " locally."))
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--push", action="store_true", help="Push the merge to origin/main")
    args = parser.parse_args()
    try:
        sync(push=args.push)
    except (RuntimeError, OSError) as exc:
        print(f"Sync failed: {exc}", file=sys.stderr)
        sys.exit(1)
