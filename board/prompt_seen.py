#!/usr/bin/python3
"""Run by Claude Code's Notification hook: notes when a session's approval box waits for the person.

Claude Code sends the notice once a permission box has been left unanswered for a few seconds (the
desktop app and VS Code) or when it opens (the terminal). The board's server reads the time this
leaves, so a session in auto mode shows "Needs approval" only while a box is really in front of the
person. Mods do not hear the notice, so a settings hook has to. It never fails the session: any
problem ends it quietly.
"""

import json
import os
import re
import sys
import time
from pathlib import Path

PROMPTS_DIR = Path(os.environ.get("CCC_PROMPTS_DIR", Path.home() / ".claude" / "ccc" / "prompts"))
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
MAX_INPUT_BYTES = 256 * 1024


def seen_prompt(notice):
    """The session whose own approval box the notice is about, or None for any other notice.

    A subagent's box is left out: the board knows only the main thread's approvals."""
    if not isinstance(notice, dict) or notice.get("notification_type") != "permission_prompt":
        return None
    if notice.get("agent_id"):
        return None
    session_id = notice.get("session_id")
    return session_id if isinstance(session_id, str) and SAFE_ID.match(session_id) else None


def note(prompts_dir, session_id, now_ms):
    """Leaves the time for the session, written whole so the server never reads half a file."""
    prompts_dir.mkdir(parents=True, exist_ok=True)
    target = prompts_dir / f"{session_id}.json"
    temporary = prompts_dir / f".{session_id}.{os.getpid()}.tmp"
    temporary.write_text(json.dumps({"at": now_ms}))
    os.replace(temporary, target)


def main():
    try:
        notice = json.loads(sys.stdin.buffer.read(MAX_INPUT_BYTES) or b"null")
        session_id = seen_prompt(notice)
        if session_id:
            note(PROMPTS_DIR, session_id, int(time.time() * 1000))
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
