"""The files of a session's folder, for the "@" menu of a chat's write box: typed "@" and a few letters,
the board asks for the files whose names hold them, as the Claude app's prompt box offers them.

The board names only the session; the server takes its folder from the session's own transcript, so a
page can never list a folder of its own choosing. Only names are given, never what a file holds.
"""

import os
import subprocess
import threading
import time

# how long a folder's list is kept before it is read again
FRESH_S = 15
# the most files a folder's list holds; a bigger folder is cut there
MOST_FILES = 50_000
SHOWN = 12
# folders a walk does not go into: tools' own, packages and build output (git leaves out what it ignores)
SKIPPED = {".git", "node_modules", ".venv", "venv", "__pycache__", "build", "dist", "target", ".gradle", ".idea", ".next", ".cache", "Pods", "DerivedData"}


class FileLists:
    """Each folder's files, relative to it, read now and then and kept in between."""

    def __init__(self, clock=time.time, run=subprocess.run):
        self.clock = clock
        self.run = run
        self.kept = {}
        self.lock = threading.Lock()

    def files(self, folder: str) -> list:
        now = self.clock()
        with self.lock:
            kept = self.kept.get(folder)
            if kept and now - kept[0] < FRESH_S:
                return kept[1]
        found = git_files(folder, self.run)
        if found is None:
            found = walked_files(folder)
        with self.lock:
            self.kept[folder] = (now, found)
        return found


def git_files(folder: str, run=subprocess.run):
    """The folder's files as git knows them, tracked and new but not ignored; None outside a repository."""
    try:
        done = run(["git", "-C", folder, "ls-files", "-co", "--exclude-standard", "-z"], capture_output=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    return [name for name in done.stdout.decode("utf-8", errors="replace").split("\0") if name][:MOST_FILES]


def walked_files(folder: str) -> list:
    """The folder's files by walking it, without hidden folders and the ones in SKIPPED."""
    found = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = sorted(d for d in dirs if d not in SKIPPED and not d.startswith("."))
        base = os.path.relpath(root, folder)
        for name in sorted(files):
            found.append(name if base == "." else f"{base}/{name}")
            if len(found) >= MOST_FILES:
                return found
    return found


def with_folders(files: list) -> list:
    """The files and the folders they are in, each folder once and ending in "/"."""
    folders = set()
    for path in files:
        parts = path.split("/")[:-1]
        for depth in range(1, len(parts) + 1):
            folders.add("/".join(parts[:depth]) + "/")
    return sorted(folders) + list(files)


def matches(paths: list, typed: str, shown: int = SHOWN) -> list:
    """The paths for what was typed after "@", best first: a name that is it, that starts with it, that
    holds it, then a path that holds it, then one that has its letters in order. Shorter paths first
    within each. With nothing typed, what lies at the top of the folder."""
    want = typed.lower().strip()
    if not want:
        top = [path for path in paths if path.rstrip("/").count("/") == 0]
        return sorted(top, key=lambda path: (not path.endswith("/"), path.lower()))[:shown]
    ranked = []
    for path in paths:
        low = path.lower()
        name = low.rstrip("/").rsplit("/", 1)[-1]
        if name == want or name == want.rstrip("/"):
            tier = 0
        elif name.startswith(want):
            tier = 1
        elif want in name:
            tier = 2
        elif want in low:
            tier = 3
        elif in_order(want, low):
            tier = 4
        else:
            continue
        ranked.append((tier, len(path), low, path))
    ranked.sort()
    return [path for *_, path in ranked[:shown]]


def in_order(want: str, text: str) -> bool:
    """Whether the letters of `want` come in `text` in that order, with anything between."""
    at = 0
    for letter in want:
        at = text.find(letter, at)
        if at < 0:
            return False
        at += 1
    return True
