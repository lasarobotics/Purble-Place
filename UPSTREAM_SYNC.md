# Automatic upstream sync

Source: `https://github.com/lasarobotics/HazeHub-2-.git`, branch `main`.
Destination: this repository's `main` branch.

Commit and push these files to this repository's default `main` branch to activate
the workflow. GitHub Actions must be enabled and allowed to write repository
contents. **Actions → Sync upstream main → Run workflow** runs it immediately.
The workflow starts on changes to the automation, a manual dispatch, and a
five-minute schedule. Each run stays active for 55 checks at roughly 60-second
intervals. Concurrency allows one active run and one pending replacement, so a
scheduled replacement can start when the current run ends. GitHub outages, queues,
billing limits, and long Git operations can still interrupt that cadence. This
keeps a hosted Actions runner active most of the day (roughly 1,440 runner minutes
per day), including when upstream has no changes.

**Private main's tracked app files exactly match upstream main.** Private-only
application files and private edits are removed. Only the four paths in the
script's `PRESERVE` list remain private: this workflow, the sync script, its tests,
and this document. History is retained through normal commits; pushes never use
force. Even an already-merged upstream commit repairs a divergent private tree.
A separate temporary Git index constructs the tree without executing upstream
code. Concurrent pushes are rejected and retried by the next fresh workflow run.
Failures appear in Actions; a run must actually be visible there to confirm it
is operating. Scheduled configuration alone is not evidence of a successful sync.

The source repository is private. Set the destination repository's encrypted
Actions secret `UPSTREAM_READ_TOKEN` to a token with **Contents: read** access to
`lasarobotics/HazeHub-2-` (and organization approval if required). The default
`GITHUB_TOKEN` cannot read another private repository. Source authentication is
passed only to that fetch, in memory. Without this secret the workflow stops with
an explicit setup error. `UPSTREAM_SYNC_TOKEN` is accepted as a fallback when it
already has access to both repositories.

The default token is sufficient for ordinary destination contents writes. If upstream changes
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
python scripts/sync_upstream.py         # mirror locally
python scripts/sync_upstream.py --push  # mirror and push to origin/main
python scripts/test_sync_upstream.py   # isolated local Git tests, no GitHub writes
```

This updates the GitHub branch when run in Actions. It does not silently overwrite
an open laptop checkout; use `git pull` there when ready. The script refuses dirty
working trees. Review upstream changes before relying on the updated app.

GitHub references: [scheduled and dispatch events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
[token-triggered workflows](https://docs.github.com/en/actions/concepts/security/github_token).
