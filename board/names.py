"""The names CCC's programs show in Activity Monitor (and in top or a Linux system monitor).

They are Python programs, and a program shows under the name of the file that was started: here,
Python's own. So CCC starts them through a file named after them (SERVER, KEEPER), kept in
~/.claude/ccc/programs. On a Mac that file is a copy of Python's own small program (a link would
not do: the Mac follows it and shows "Python" again); elsewhere it is a link to Python. It is made
again at each start when Python changed, so it follows Python when Python is updated. Where none
can be made (Windows, for now), the program is started as plain Python. (A Mac shows up to 32
letters of a name; Linux only the first 15.)

    python3 names.py server   prints the program to start CCC's server with
"""

import filecmp
import os
import shutil
import sys
from pathlib import Path

SERVER = "Claude Command Central"
KEEPER = "Claude Command Central keeper"
PROGRAMS = Path(os.environ.get("CCC_PROGRAMS_DIR", Path.home() / ".claude" / "ccc" / "programs"))


def python_itself() -> tuple:
    """The file Python really runs from, and whether a copy of it runs as well as the file itself.

    On a Mac, Python from Homebrew or python.org starts a second program inside Python.app, which
    would show as "Python" whatever the first was named. That small program finds the rest of
    Python wherever it is, so a copy of it works. Any other Python looks for the rest next to its
    own file, so it gets a link."""
    inside_app = Path(sys.base_prefix) / "Resources" / "Python.app" / "Contents" / "MacOS" / "Python"
    if sys.platform == "darwin" and inside_app.is_file():
        return str(inside_app), True
    return os.path.realpath(sys.executable), False


def program(name: str, folder: Path = PROGRAMS, python: tuple = None) -> str:
    """A Python that shows as `name`, or plain Python when none can be made."""
    source, is_copied = python or python_itself()
    if os.name != "posix":
        return sys.executable
    target = folder / name
    try:
        if is_copied and target.is_file() and not target.is_symlink() and filecmp.cmp(source, target, shallow=False):
            return str(target)
        folder.mkdir(parents=True, exist_ok=True)
        # made beside the old one and moved over it, so a program starting now never finds none
        new = folder / f".{name}.{os.getpid()}"
        new.unlink(missing_ok=True)
        if is_copied:
            shutil.copy2(source, new)
        else:
            new.symlink_to(source)
        os.replace(new, target)
    except OSError:
        return sys.executable
    return str(target)


if __name__ == "__main__":
    print(program(SERVER) if sys.argv[1:] == ["server"] else sys.executable)
