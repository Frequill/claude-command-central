"""Opening a file a step touched in the person's own editor (IntelliJ IDEA, VS Code), at its line.

The board says only which step was clicked; the server reads the file from that step in the session's
own transcript, so a page can never name a file of its own choosing. Nothing is run but the editor,
given the file as an argument.
"""

import os
import subprocess
from pathlib import Path

# the editors CCC knows, by the app bundles they come as; the first one installed of each is used
EDITORS = (
    {"id": "intellij", "name": "IntelliJ IDEA", "apps": ("IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app", "IntelliJ IDEA CE.app")},
    {"id": "vscode", "name": "VS Code", "apps": ("Visual Studio Code.app", "Visual Studio Code - Insiders.app")},
)
EDITOR_CHOICES = ("auto", "intellij", "vscode")


def installed_editors(applications=Path("/Applications")) -> list:
    """The editors this Mac has, each with the app it comes as."""
    found = []
    for editor in EDITORS:
        app = next((applications / name for name in editor["apps"] if (applications / name).is_dir()), None)
        if app is not None:
            found.append({"id": editor["id"], "name": editor["name"], "app": str(app)})
    return found


def is_running(app: str, run=subprocess.run) -> bool:
    try:
        return run(["pgrep", "-f", f"{app}/Contents/MacOS/"], capture_output=True, timeout=3).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def chosen_editor(asked, editors: list, running=is_running):
    """The editor to open in: the one asked for when this Mac has it; for 'auto' the one running
    (IntelliJ first), else the first installed. None when there is none."""
    if not editors:
        return None
    named = next((editor for editor in editors if editor["id"] == asked), None)
    if named is not None:
        return named
    return next((editor for editor in editors if running(editor["app"])), editors[0])


def open_command(editor: dict, path: str, line: int) -> list:
    """The command that opens the file at the line: IntelliJ through its app (it hands the file to the
    one already running), VS Code through the `code` command its app brings."""
    line = max(1, int(line or 1))
    if editor["id"] == "vscode":
        return [os.path.join(editor["app"], "Contents/Resources/app/bin/code"), "--goto", f"{path}:{line}"]
    return ["open", "-na", editor["app"], "--args", "--line", str(line), path]


def open_file(editor: dict, path: str, line: int, run=subprocess.run) -> str:
    """Opens it; what went wrong, or '' when it is on its way. Both commands hand the file to the
    editor and end at once, so waiting for them is short."""
    if not os.path.isfile(path):
        return "That file is not there any more."
    try:
        done = run(open_command(editor, path, line), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        return ""
    except (OSError, subprocess.SubprocessError):
        return f"Could not open {editor['name']}."
    return "" if done.returncode == 0 else f"Could not open {editor['name']}. " + (done.stderr or "").strip()[:200]
