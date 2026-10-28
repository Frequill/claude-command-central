#!/usr/bin/python3
"""Run by Claude Code's PermissionRequest hook for AskUserQuestion: lets the person answer a
question box from CCC's chat window instead of the Claude app.

Claude Code puts the box in front of the person and runs this hook at the same time; whichever
answers first wins, and the other is withdrawn. This hook waits for an answer the board's server
leaves for the session, and hands it over as the box's answers. When the person answers in the app
instead, or nothing comes, it ends without a word and the app decides as usual.

Only the desktop app and VS Code run the two side by side, so in a terminal session it ends at once.
It never fails the session: any problem ends it quietly.
"""

import json
import os
import re
import sys
import time
from pathlib import Path

ANSWERS_DIR = Path(os.environ.get("CCC_ANSWERS_DIR", Path.home() / ".claude" / "ccc" / "answers"))
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
SIDE_BY_SIDE = {"claude-desktop", "claude-vscode"}
QUESTION_TOOL = "AskUserQuestion"
MAX_INPUT_BYTES = 1024 * 1024
POLL_S = 0.5
TRANSCRIPT_EVERY_S = 2.0
TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024
MAX_WAIT_S = float(os.environ.get("CCC_ANSWER_WAIT_S", 3500))
EARLY_S = 60
# words the person wrote instead of answering go to Claude as the Claude app sends them
FEEDBACK = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n"
REPLY_MAX = 20_000


def box_of(notice):
    """(session id, the box's input, its question texts) when the notice is a main-thread question
    box this hook can answer, else None."""
    if not isinstance(notice, dict) or notice.get("tool_name") != QUESTION_TOOL or notice.get("agent_id"):
        return None
    session_id = notice.get("session_id")
    given = notice.get("tool_input")
    questions = given.get("questions") if isinstance(given, dict) else None
    if not isinstance(session_id, str) or not SAFE_ID.match(session_id) or not isinstance(questions, list):
        return None
    texts = [one.get("question") for one in questions if isinstance(one, dict)]
    if not texts or not all(isinstance(text, str) and text for text in texts):
        return None
    return session_id, given, texts


def read_answer(path: Path, texts: list, since_ms: float):
    """The answers the board left for this very box ({question: answer}), or None. An answer for
    other questions, or one left long before the box was put, is not this box's."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("questions") != texts:
        return None
    at = data.get("at")
    answers = data.get("answers")
    if not isinstance(at, (int, float)) or at < since_ms - EARLY_S * 1000:
        return None
    # a reply in the person's own words, written in the chat while the box waited
    if isinstance(data.get("message"), str) and data["message"].strip():
        return {"message": data["message"].strip()[:REPLY_MAX]}
    if not isinstance(answers, dict):
        return None
    if set(answers) != set(texts) or not all(isinstance(value, str) for value in answers.values()):
        return None
    return answers


def take(path: Path):
    """Marks an answer used, so it is never handed over twice."""
    try:
        os.replace(path, path.with_suffix(".taken"))
    except OSError:
        pass


def decision(given: dict, answers: dict) -> dict:
    """The box answered with the picks, or turned down with the person's own words to go on with."""
    if "message" in answers:
        return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny", "message": FEEDBACK + answers["message"]}}}
    return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow", "updatedInput": {**given, "answers": answers}}}}


def answered_elsewhere(transcript, texts: list) -> bool:
    """Whether the transcript already holds the result of the latest box with these questions: the
    person answered it in the app, turned it down, or the turn was stopped."""
    try:
        path = Path(transcript)
        size = path.stat().st_size
        with path.open("rb") as handle:
            handle.seek(max(0, size - TRANSCRIPT_TAIL_BYTES))
            lines = handle.read().split(b"\n")
    except (OSError, TypeError, ValueError):
        return False
    box_id = None
    for line in lines:
        if box_id is None and QUESTION_TOOL.encode() not in line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        content = record.get("message", {}).get("content") if isinstance(record, dict) and isinstance(record.get("message"), dict) else None
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use" and block.get("name") == QUESTION_TOOL:
                asked = (block.get("input") or {}).get("questions") if isinstance(block.get("input"), dict) else None
                if isinstance(asked, list) and [one.get("question") for one in asked if isinstance(one, dict)] == texts:
                    box_id = block.get("id")
            elif block.get("type") == "tool_result" and box_id and block.get("tool_use_id") == box_id:
                return True
    return False


def wait_for_answer(session_id: str, given: dict, texts: list, transcript, clock=time.time, sleep=time.sleep):
    """The decision to print once an answer comes from CCC, or None when the box ended otherwise."""
    started = clock()
    path = ANSWERS_DIR / f"{session_id}.json"
    checked = started
    while clock() - started < MAX_WAIT_S:
        answers = read_answer(path, texts, started * 1000)
        if answers is not None:
            take(path)
            return decision(given, answers)
        if clock() - checked >= TRANSCRIPT_EVERY_S:
            checked = clock()
            if answered_elsewhere(transcript, texts):
                return None
        sleep(POLL_S)
    return None


def main():
    try:
        if os.environ.get("CLAUDE_CODE_ENTRYPOINT") not in SIDE_BY_SIDE:
            return 0
        notice = json.loads(sys.stdin.buffer.read(MAX_INPUT_BYTES) or b"null")
        box = box_of(notice)
        if box is None:
            return 0
        session_id, given, texts = box
        answer = wait_for_answer(session_id, given, texts, notice.get("transcript_path"))
        if answer is not None:
            sys.stdout.write(json.dumps(answer))
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
