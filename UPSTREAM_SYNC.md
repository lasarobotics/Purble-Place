# Automatic upstream sync

Source: `https://github.com/lasarobotics/HazeHub-2-.git`, branch `main`.
Destination: this repository's `main` branch.

Commit and push these files to this repository's default `main` branch to activate
the workflow. GitHub Actions must be enabled and allowed to write repository
contents. **Actions → Sync upstream main → Run workflow** runs it immediately.
GitHub starts a scheduled run every five minutes (its minimum scheduling interval).
Each run checks five times, roughly one minute apart, while keeping its runner
active. This uses about four runner minutes per scheduled run even when no code
changes. GitHub can delay scheduled runs, so there can still be gaps between runs;
this is not a guaranteed 60-second service. It syncs the latest upstream tip,
including intervening commits, rather than guaranteeing one workflow run for
every individual upstream push.

The script merges upstream history and favors upstream at conflicting code paths,
including upstream deletion of a locally modified file. Nonconflicting private
changes remain. It is a merge, not an exact mirror. The workflow, script, its tests,
and this document always retain their private-repository versions, even if upstream
changes or deletes them. It never force-pushes. A concurrent destination push is
rejected and retried on the next scheduled run. Failures appear in Actions.

The default token is sufficient for ordinary contents writes. If upstream changes
other `.github/workflows` files, configure repository secret `UPSTREAM_SYNC_TOKEN`
with a fine-grained token permitted to write **Contents** and **Workflows** in this
private repository. Branch protection rules still apply. Pushes made with the
default `GITHUB_TOKEN` do not trigger other push workflows; use an appropriately
scoped token if deployment/CI must run on synced commits. Never put tokens in files.

## Immediate push notification (optional)

For event-driven sync, an upstream-maintained workflow or webhook can POST a
`repository_dispatch` event named `upstream-main-pushed` to this private repository.
It needs a token with access to the destination repository. The destination always
fetches the fixed upstream main branch; dispatch payloads cannot choose code or
shell commands. Polling remains a fallback. No upstream webhook is installed by
adding these local files.

## Local use

From a clean clone on `main`, with Python 3 and Git installed:

```powershell
python scripts/sync_upstream.py         # merge locally
python scripts/sync_upstream.py --push  # merge and push to origin/main
python scripts/test_sync_upstream.py   # isolated local Git tests, no GitHub writes
```

This updates the GitHub branch when run in Actions. It does not silently overwrite
an open laptop checkout; use `git pull` there when ready. The script refuses dirty
working trees. Review upstream changes before relying on the updated app.

GitHub references: [scheduled and dispatch events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
[token-triggered workflows](https://docs.github.com/en/actions/concepts/security/github_token).
