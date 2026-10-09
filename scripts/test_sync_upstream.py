"""Integration tests using only temporary local Git repositories."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import sync_upstream as subject


class SyncTests(unittest.TestCase):
    def command(self, directory, *args):
        return subprocess.check_output(["git", "-C", str(directory), *args],
                                       stderr=subprocess.STDOUT).decode().strip()

    def write(self, directory, name, text):
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def commit(self, directory, message):
        self.command(directory, "add", "-A")
        self.command(directory, "commit", "-m", message)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hazehub-sync-test-", ignore_cleanup_errors=True)
        self.root = Path(self.temp.name)
        self.upstream = self.root / "upstream"
        self.origin = self.root / "private.git"
        self.checkout = self.root / "checkout"
        self.command(self.root, "init", "-b", "main", str(self.upstream))
        self.command(self.upstream, "config", "user.name", "Sync test")
        self.command(self.upstream, "config", "user.email", "sync@example.invalid")
        self.write(self.upstream, "app.txt", "initial\n")
        self.write(self.upstream, "removed.txt", "initial\n")
        for name in subject.PRESERVE:
            self.write(self.upstream, name, "initial automation\n")
        self.commit(self.upstream, "initial")
        self.command(self.root, "clone", "--bare", str(self.upstream), str(self.origin))
        self.command(self.root, "clone", str(self.origin), str(self.checkout))
        self.command(self.checkout, "config", "user.name", "Sync test")
        self.command(self.checkout, "config", "user.email", "sync@example.invalid")
        self.previous = Path.cwd()
        os.chdir(self.checkout)

    def tearDown(self):
        os.chdir(self.previous)
        self.temp.cleanup()

    def test_exact_mirror_deletions_and_preserve_automation(self):
        self.write(self.checkout, "app.txt", "private edit\n")
        self.write(self.checkout, "removed.txt", "private edit\n")
        self.write(self.checkout, "private-only.txt", "keep this\n")
        for name in subject.PRESERVE:
            self.write(self.checkout, name, "private automation\n")
        self.commit(self.checkout, "private changes")
        self.command(self.checkout, "push", "origin", "main")
        self.write(self.upstream, "app.txt", "new upstream\n")
        (self.upstream / "removed.txt").unlink()
        for name in subject.PRESERVE:
            (self.upstream / name).unlink()
        self.commit(self.upstream, "upstream changes")
        self.assertTrue(subject.sync(str(self.upstream), push=True))
        self.assertEqual((self.checkout / "app.txt").read_text(), "new upstream\n")
        self.assertFalse((self.checkout / "removed.txt").exists())
        self.assertFalse((self.checkout / "private-only.txt").exists())
        for name in subject.PRESERVE:
            self.assertEqual((self.checkout / name).read_text(), "private automation\n")
        self.assertEqual(self.command(self.checkout, "status", "--porcelain"), "")
        self.assertEqual(self.command(self.checkout, "rev-parse", "HEAD"),
                         self.command(self.origin, "rev-parse", "main"))
        head = self.command(self.checkout, "rev-parse", "HEAD")
        self.assertFalse(subject.sync(str(self.upstream), push=True))
        self.assertEqual(head, self.command(self.checkout, "rev-parse", "HEAD"))

    def test_private_changes_removed_even_when_upstream_is_ancestor(self):
        self.write(self.checkout, "app.txt", "private edit\n")
        self.write(self.checkout, "private-only.txt", "remove this\n")
        self.commit(self.checkout, "private divergence")
        self.command(self.checkout, "push", "origin", "main")
        self.assertTrue(subject.sync(str(self.upstream), push=True))
        self.assertEqual((self.checkout / "app.txt").read_text(), "initial\n")
        self.assertFalse((self.checkout / "private-only.txt").exists())
        self.assertEqual(self.command(self.checkout, "diff", "--name-only", "HEAD", self.command(self.upstream, "rev-parse", "HEAD")), "")

    def test_dirty_checkout_refused(self):
        self.write(self.checkout, "app.txt", "unsaved work\n")
        with self.assertRaisesRegex(RuntimeError, "Uncommitted"):
            subject.sync(str(self.upstream))
        self.assertEqual((self.checkout / "app.txt").read_text(), "unsaved work\n")

    def test_wrong_branch_refused(self):
        self.command(self.checkout, "checkout", "-b", "other")
        with self.assertRaisesRegex(RuntimeError, "main branch"):
            subject.sync(str(self.upstream))

    def test_local_merge_can_be_pushed_on_next_invocation(self):
        self.write(self.upstream, "app.txt", "new upstream\n")
        self.commit(self.upstream, "new code")
        self.assertTrue(subject.sync(str(self.upstream)))
        self.assertNotEqual(self.command(self.checkout, "rev-parse", "HEAD"),
                            self.command(self.origin, "rev-parse", "main"))
        self.assertTrue(subject.sync(str(self.upstream), push=True))
        self.assertEqual(self.command(self.checkout, "rev-parse", "HEAD"),
                         self.command(self.origin, "rev-parse", "main"))


if __name__ == "__main__":
    unittest.main()
