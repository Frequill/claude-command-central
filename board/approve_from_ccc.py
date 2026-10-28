#!/usr/bin/python3
"""Run by Claude Code's PermissionRequest hook for the tools that ask for approval: lets the person
allow or deny a call from CCC's chat window instead of the Claude app.

Claude Code puts its approval box in front of the person and runs this hook at the same time;
whichever answers first wins. While the box waits, this hook leaves a note of it for the board (the
call it is about), and takes the decision the board's server leaves for that very note. When the
person answers in the app instead, the turn is stopped or nothing comes, it takes its note away and
ends without a word, and the app decides as usual.

Only the desktop app and VS Code run the two side by side, so in a terminal session it ends at once.
It never fails the session: any problem ends it quietly.
"""

import json
import os
import re
import secrets
import signal
import sys
import time
from pathlib import Path

APPROVALS_DIR = Path(os.environ.get("CCC_APPROVALS_DIR", Path.home() / ".claude" / "ccc" / "approvals"))
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
SIDE_BY_SIDE = {"claude-desktop", "claude-vscode"}
# the question box and the plan have boxes of their own; answer_from_ccc.py takes the questions
OWN_BOXES = {"AskUserQuestion", "ExitPlanMode"}
MAX_INPUT_BYTES = 1024 * 1024
POLL_S = 0.5
TRANSCRIPT_EVERY_S = 2.0
TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024
MAX_WAIT_S = float(os.environ.get("CCC_APPROVAL_WAIT_S", 3500))
DESCRIPTION_MAX = 300
COMMAND_MAX = 20_000
DETAIL_MAX = 4_000
# what the file or address of a call is called in its input, by the tools that touch one
TARGET_KEYS = ("file_path", "notebook_path", "url", "path")
DENIED = "The person turned this down in CCC."
# the words the person wrote instead of answering the box go to Claude as the Claude app sends them:
# the call turned down, and what to do instead, so Claude goes on with it in the same turn
FEEDBACK = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n"
REPLY_MAX = 20_000
# the Claude app's branch question: a tool call the app shows as a choice, not an approval. The app
# answers it by allowing the call with the choice put in its input under this key; CCC does the same
BRANCH_TOOL = "mcp__ccd_directory__propose_branch"
BRANCH_ANSWER_KEY = "_setupAnswer"
BRANCH_NAME_MAX = 100
BRANCH_CHOICES = ("new", "stay")


def box_of(notice):
    """(session id, tool, its input) when the notice is a main-thread approval box this hook can
    answer, else None. A subagent's box is left out: the board knows only the main thread."""
    if not isinstance(notice, dict) or notice.get("agent_id"):
        return None
    tool = notice.get("tool_name")
    session_id = notice.get("session_id")
    given = notice.get("tool_input")
    if not isinstance(tool, str) or not tool or tool in OWN_BOXES or not isinstance(given, dict):
        return None
    if not isinstance(session_id, str) or not SAFE_ID.match(session_id):
        return None
    return session_id, tool, given


def shown(tool: str, given: dict) -> dict:
    """What the board shows of the call, as the app's box does: what it is for, and the command,
    or the file or address it touches, or else its input."""

    def text(key, limit):
        value = given.get(key)
        return value[:limit] if isinstance(value, str) else ""

    description = text("description", DESCRIPTION_MAX)
    if tool == BRANCH_TOOL:
        return {"kind": "branch", "suggested": text("suggested", BRANCH_NAME_MAX)}
    if tool == "Bash" and text("command", COMMAND_MAX):
        return {"description": description, "command": text("command", COMMAND_MAX)}
    target = next((text(key, DETAIL_MAX) for key in TARGET_KEYS if text(key, DETAIL_MAX)), "")
    if target:
        return {"description": description, "target": target}
    try:
        detail = json.dumps(given, ensure_ascii=False, indent=2)[:DETAIL_MAX]
    except (TypeError, ValueError):
        detail = ""
    return {"description": description, "detail": detail}


def write_whole(path: Path, data: dict):
    """Writes the file whole, so the server never reads half of it."""
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(data))
    os.replace(temporary, path)


def is_ours(path: Path, box_id: str) -> bool:
    try:
        return json.loads(path.read_text()).get("box") == box_id
    except (OSError, ValueError, AttributeError):
        return False


def take_note_away(path: Path, ended_path: Path, note: dict, ended_ms: int):
    """Takes the note down, unless another box of the session has put its own there since, and
    leaves word that the box was answered: the board stops saying the session waits for approval
    while the call it allowed runs."""
    try:
        if is_ours(path, note["box"]):
            write_whole(ended_path, {"box": note["box"], "at": note["at"], "endedAt": ended_ms})
            path.unlink()
    except OSError:
        pass


def read_decision(path: Path, box_id: str):
    """('allow' or 'deny', the branch picked or None) when the board left one for this very box, else None."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("box") != box_id:
        return None
    chosen = data.get("decision")
    branch = data.get("branch") if data.get("branch") in BRANCH_CHOICES else None
    said = data.get("message") if chosen == "deny" and isinstance(data.get("message"), str) else None
    return (chosen, branch, said[:REPLY_MAX] if said else None) if chosen in ("allow", "deny") else None


def take(path: Path):
    """Marks a decision used, so it is never handed over twice."""
    try:
        os.replace(path, path.with_suffix(".taken"))
    except OSError:
        pass


def decision(chosen: str, tool: str = "", given: dict = None, branch: str = None, said: str = None) -> dict:
    """What the hook prints. A branch picked in CCC goes in as the app's own answer would: the call
    allowed, with the choice in its input (a new branch takes the name Claude suggested)."""
    answer = {"behavior": "allow"} if chosen == "allow" else {"behavior": "deny", "message": FEEDBACK + said if said else DENIED}
    if chosen == "allow" and tool == BRANCH_TOOL and branch in BRANCH_CHOICES:
        picked = {"kind": "branch", "choice": "stay"}
        if branch == "new":
            picked = {"kind": "branch", "choice": "new", "name": (given or {}).get("suggested", "")}
        answer["updatedInput"] = {**(given or {}), BRANCH_ANSWER_KEY: picked}
    return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": answer}}


def answered_elsewhere(transcript, tool: str, given: dict) -> bool:
    """Whether the transcript already holds the result of the latest call like this one: the
    person turned it down in the app, the turn was stopped, or it was allowed and has run."""
    try:
        path = Path(transcript)
        size = path.stat().st_size
        with path.open("rb") as handle:
            handle.seek(max(0, size - TRANSCRIPT_TAIL_BYTES))
            lines = handle.read().split(b"\n")
    except (OSError, TypeError, ValueError):
        return False
    # the call is known by what the box shows of it, so a field the engine adds to the input does not hide it
    wanted = shown(tool, given)
    call_id = None
    is_done = False
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        message = record.get("message") if isinstance(record, dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use" and block.get("name") == tool and isinstance(block.get("input"), dict) and shown(tool, block["input"]) == wanted:
                call_id, is_done = block.get("id"), False
            elif block.get("type") == "tool_result" and call_id and block.get("tool_use_id") == call_id:
                is_done = True
    return is_done


def wait_for_decision(session_id: str, tool: str, given: dict, transcript, clock=time.time, sleep=time.sleep):
    """The decision to print once one comes from CCC, or None when the box ended otherwise. The
    note stays up while the box waits, renewed now and then so the board knows the hook still runs."""
    APPROVALS_DIR.mkdir(parents=True, exist_ok=True)
    box_id = secrets.token_hex(8)
    note_path = APPROVALS_DIR / f"{session_id}.box.json"
    answer_path = APPROVALS_DIR / f"{session_id}.answer.json"
    ended_path = APPROVALS_DIR / f"{session_id}.ended.json"
    started = clock()
    note = {"box": box_id, "tool": tool, "at": int(started * 1000), "beat": int(started * 1000), **shown(tool, given)}
    write_whole(note_path, note)
    try:
        checked = started
        while clock() - started < MAX_WAIT_S:
            read = read_decision(answer_path, box_id)
            if read is not None:
                take(answer_path)
                return decision(read[0], tool, given, read[1], read[2])
            if clock() - checked >= TRANSCRIPT_EVERY_S:
                checked = clock()
                if answered_elsewhere(transcript, tool, given):
                    return None
                if is_ours(note_path, box_id):
                    write_whole(note_path, {**note, "beat": int(checked * 1000)})
            sleep(POLL_S)
        return None
    finally:
        take_note_away(note_path, ended_path, note, int(clock() * 1000))


def leave_on_signal(signum, _frame):
    """Claude Code withdraws the hook when the box was answered in the app: the note comes down."""
    raise SystemExit(0)


def main():
    try:
        if os.environ.get("CLAUDE_CODE_ENTRYPOINT") not in SIDE_BY_SIDE:
            return 0
        notice = json.loads(sys.stdin.buffer.read(MAX_INPUT_BYTES) or b"null")
        box = box_of(notice)
        if box is None:
            return 0
        for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(signum, leave_on_signal)
        answer = wait_for_decision(*box, notice.get("transcript_path"))
        if answer is not None:
            sys.stdout.write(json.dumps(answer))
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
