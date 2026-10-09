#!/usr/bin/env python3
"""Mirror upstream main plus private sync files, preserving Git history."""
import argparse
import base64
import os
import tempfile
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


def git(*args, check=True, env=None):
    result = subprocess.run(["git", *args], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env)
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

    git("fetch", "--no-tags", "origin", "main")
    origin_tip = git("rev-parse", "FETCH_HEAD").stdout.strip()
    git("merge", "--ff-only", "FETCH_HEAD")
    previous = git("rev-parse", "HEAD").stdout.decode().strip()
    saved = {}
    for name in PRESERVE:
        record = git("ls-tree", "HEAD", "--", name).stdout
        if not record:
            raise RuntimeError(f"Required sync file is missing: {name}")
        mode, kind, oid = record.split(b"\t", 1)[0].decode().split()
        if kind != "blob" or mode not in ("100644", "100755"):
            raise RuntimeError(f"Sync file must be a regular tracked file: {name}")
        saved[name] = (mode, oid)
    upstream_env = None
    token = os.environ.get("UPSTREAM_READ_TOKEN")
    if token and upstream == UPSTREAM:
        # checkout's GITHUB_TOKEN is destination-only. Use a separate credential
        # for this one source fetch; never embed credentials in URLs or files.
        authorization = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        upstream_env = dict(os.environ)
        count = int(upstream_env.get("GIT_CONFIG_COUNT", "0"))
        settings = [
            ("http.https://github.com/.extraheader", ""),
            (f"http.{UPSTREAM}.extraheader", f"AUTHORIZATION: basic {authorization}"),
        ]
        for key, value in settings:
            upstream_env[f"GIT_CONFIG_KEY_{count}"] = key
            upstream_env[f"GIT_CONFIG_VALUE_{count}"] = value
            count += 1
        upstream_env["GIT_CONFIG_COUNT"] = str(count)
    git("fetch", "--no-tags", upstream, "refs/heads/main", env=upstream_env)
    incoming = git("rev-parse", "FETCH_HEAD").stdout.decode().strip()

    # Build the exact desired tree in a separate index. This removes private-only
    # app files and edits, even if upstream's commit is already in our history.
    # No upstream script is executed and no working files change until complete.
    with tempfile.TemporaryDirectory(prefix="hazehub-sync-index-") as temporary:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(temporary) / "index"))
        git("read-tree", incoming, env=env)
        for name, (mode, oid) in saved.items():
            git("update-index", "--add", "--cacheinfo", f"{mode},{oid},{name}", env=env)
        desired = git("write-tree", env=env).stdout.decode().strip()
    current = git("rev-parse", "HEAD^{tree}").stdout.decode().strip()
    if desired == current:
        if push and previous.encode() != origin_tip:
            git("push", "origin", "HEAD:refs/heads/main")
            print("Already mirrored; pushed pending local commits.", flush=True)
            return True
        print(f"Already mirrored upstream {incoming[:12]}; no changes.", flush=True)
        return False

    parents = ["-p", previous]
    if git("merge-base", "--is-ancestor", incoming, previous, check=False).returncode:
        parents += ["-p", incoming]
    commit = git("commit-tree", desired, *parents, "-m",
                 f"Mirror upstream main ({incoming[:12]}) plus sync automation").stdout.decode().strip()
    git("merge", "--ff-only", commit)

    if push:
        # A concurrent user push rejects this push; the next run retries safely.
        git("push", "origin", "HEAD:refs/heads/main")
    print(f"Synced upstream {incoming[:12]}" + (" and pushed main." if push else " locally."))
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--push", action="store_true", help="Push the mirrored tree to origin/main")
    args = parser.parse_args()
    try:
        sync(push=args.push)
    except (RuntimeError, OSError) as exc:
        print(f"Sync failed: {exc}", file=sys.stderr)
        sys.exit(1)
