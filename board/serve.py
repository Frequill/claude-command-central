#!/usr/bin/env python3
"""Serves the CCC board and every session's snapshot, on this machine only."""

import base64
import binascii
import difflib
import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

import editors
import keeper
import mentions
import terminals

HOST = "127.0.0.1"
PORT = int(os.environ.get("CCC_PORT", "8765"))
BOARD_DIR = Path(__file__).resolve().parent
CCC_DIR = Path.home() / ".claude" / "ccc"
SESSIONS_DIR = Path(os.environ.get("CCC_SESSIONS_DIR", CCC_DIR / "sessions"))
REMOVED_FILE = Path(os.environ.get("CCC_REMOVED_FILE", CCC_DIR / "removed.json"))
NOTES_FILE = Path(os.environ.get("CCC_NOTES_FILE", CCC_DIR / "notes.json"))
PINNED_FILE = Path(os.environ.get("CCC_PINNED_FILE", CCC_DIR / "pinned.json"))
PROJECTS_DIR = Path(os.environ.get("CCC_PROJECTS_DIR", Path.home() / ".claude" / "projects"))
APP_SESSIONS_DIR = Path(os.environ.get("CCC_APP_SESSIONS_DIR", Path.home() / "Library" / "Application Support" / "Claude" / "claude-code-sessions"))
APP_SESSION_ID = re.compile(r"^local_[A-Za-z0-9-]{1,64}$")
INBOX_DIR = Path(os.environ.get("CCC_INBOX_DIR", CCC_DIR / "inbox"))
UPLOADS_DIR = Path(os.environ.get("CCC_UPLOADS_DIR", CCC_DIR / "uploads"))
PROMPTS_DIR = Path(os.environ.get("CCC_PROMPTS_DIR", CCC_DIR / "prompts"))
ANSWERS_DIR = Path(os.environ.get("CCC_ANSWERS_DIR", CCC_DIR / "answers"))
APPROVALS_DIR = Path(os.environ.get("CCC_APPROVALS_DIR", CCC_DIR / "approvals"))
# each session's slash commands and models, as its mod writes them (hooks/commands.ts), for the chat's "/" menu
COMMANDS_DIR = Path(os.environ.get("CCC_COMMANDS_DIR", CCC_DIR / "commands"))
# caveman mode per session, as the person switches it in CCC; the mod reads it (hooks/caveman.ts)
CAVEMAN_DIR = Path(os.environ.get("CCC_CAVEMAN_DIR", CCC_DIR / "caveman"))
BACKGROUND_FILE = Path(os.environ.get("CCC_BACKGROUND_FILE", CCC_DIR / "background.json"))
CAVEMAN_LEVELS = ("off", "lite", "full", "ultra")
COMMANDS_MAX = 400
COMMAND_NAME = re.compile(r"^[A-Za-z0-9_:.-]{1,80}$")
MAX_ANSWER_BODY_BYTES = 64 * 1024
MAX_START_BODY_BYTES = 64 * 1024
RECENT_FOLDERS = 12
CWD_FIELD = re.compile(rb'"cwd"\s*:\s*("(?:[^"\\]|\\.){1,4096}")')
START_PLACES = ("app", "terminal", "background")
# the modes a session started in a terminal or in the background can be given (claude
# --permission-mode); '' is the person's own default from Claude Code's settings
START_MODES = ("", "manual", "acceptEdits", "plan", "auto")
# Claude's own settings file, only ever read here: it says which folders the person trusts
CLAUDE_CONFIG = Path(os.environ.get("CCC_CLAUDE_CONFIG", Path.home() / ".claude.json"))
# where claude is when the server's PATH does not have it (the server may be started from the app)
CLAUDE_PLACES = (Path.home() / ".local" / "bin" / "claude", Path.home() / ".claude" / "local" / "claude", Path("/opt/homebrew/bin/claude"), Path("/usr/local/bin/claude"))
BACKGROUND_SIZE = (120, 36)
# a session started in the background that is not on the board by then is waiting for the person,
# on something only its own screen shows: its terminal comes onto the board
BACKGROUND_WAIT_MS = 30_000
# the sessions started in the background CCC remembers, newest first, so a stopped one can be resumed
BACKGROUND_KEPT = 50
# what a resumed session gets when nothing else was written to it: Claude starts only with a message
RESUME_PROMPT = "Continue where you left off."
# a snapshot written this recently, and not ended, is a session that runs somewhere now
RUNS_NOW_MS = 60_000
PICK_TIMEOUT_S = 300
CHAT_CHUNK_BYTES = 1024 * 1024
CHAT_ITEMS = 300
CHAT_TEXT_MAX = 60_000
# a message from the board may be as long as Claude can take in, as in the Claude app: about 1 million
# tokens is about 4 million characters (a pasted log or JSON file); the first message of a Terminal
# start is typed into the shell, so it stays short
MESSAGE_TEXT_MAX = 4_000_000
START_PROMPT_MAX = 20_000
MAX_IMAGES = 6
MAX_LINE_BYTES = 40 * 1024 * 1024
TOOL_ID = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
STEP_SEARCH_BYTES = 24 * 1024 * 1024
STEP_TEXT_MAX = 30_000
QUESTION_TOOL = "AskUserQuestion"
QUESTIONS_MAX = 4
QUESTION_OPTIONS_MAX = 8
ANSWER_MAX = 4000
# a reply in the person's own words to a box, and how Claude Code hands it to Claude (the app's words)
REPLY_MAX = 20_000
FEEDBACK = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n"
MAX_IMAGE_BYTES = 10 * 1024 * 1024
# any other file dropped on the chat goes along too, as in the Claude app: Claude opens it from where it is saved
MAX_FILES = 10
MAX_FILE_BYTES = 20 * 1024 * 1024
FILE_NAME_MAX = 120
MAX_SEND_BODY_BYTES = MAX_IMAGES * MAX_IMAGE_BYTES * 4 // 3 + MAX_FILES * MAX_FILE_BYTES * 4 // 3 + MESSAGE_TEXT_MAX * 6 + 4096
IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}
SYSTEM_BLOCK = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
# a slash command or skill the person ran, as Claude Code writes it down
COMMAND_NAME_TAG = re.compile(r"<command-name>\s*(/?[^<\s]+)\s*</command-name>")
COMMAND_ARGS_TAG = re.compile(r"<command-args>(.*?)</command-args>", re.S)
# the big base64 strings of a transcript line, which the chat never shows: images, thinking signatures
PAYLOAD = re.compile(rb'("(?:data|base64|signature)":\s*")[A-Za-z0-9+/=]{1024,}"')
# how the mod names the images of a message written in CCC (hooks/inbox.ts, promptFor)
SENT_IMAGES = re.compile(r"(?:^|\n\n)Images I added \(open them with the Read tool\):\n((?:- [^\n]+(?:\n|$))+)\s*$")
# and the other files, named just before the images
SENT_FILES = re.compile(r"(?:^|\n\n)Files I added \(open them with the Read tool\):\n((?:- [^\n]+(?:\n|$))+)\s*$")
# a saved file is named `<message id>-f<n>-<its own name>`, so the chat can show its own name again
SAVED_FILE = re.compile(r"^[0-9]{1,16}-[0-9a-f]{1,32}-f[0-9]{1,2}-(.+)$")
MAX_APP_SESSIONS = 2000
TOKEN_REFRESH_S = 10
TOKEN_HISTORY_DAYS = 90
TOKEN_CHUNK_BYTES = 8 * 1024 * 1024
SNAPSHOT_VERSION = 1
TAIL_BYTES = 512 * 1024
WHOLE_FILE_LIMIT = 64 * 1024 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
MODE_FIELD = re.compile(r'"permissionMode"\s*:\s*"([A-Za-z]+)"')
ENTRY_FIELD = re.compile(r'"entrypoint"\s*:\s*"([a-z0-9-]{1,40})"')
NOTIFICATION = re.compile(r"<task-notification>(.*?)</task-notification>", re.S)
TASK_END = {"completed": "done", "failed": "failed", "killed": "failed", "stopped": "failed", "error": "failed"}
MAX_SESSIONS = 300
MAX_FILE_BYTES = 2_000_000
MAX_BODY_BYTES = 1024
MAX_NOTES_BODY_BYTES = 200_000
MAX_NOTES_TEXT = 20_000
ACTION_HEADER = "X-CCC-Action"
BOARD_FILES = {"/": "index.html", "/index.html": "index.html", "/board.css": "board.css",
               "/board.js": "board.js", "/board-logic.js": "board-logic.js", "/themes.js": "themes.js",
               "/layout.js": "layout.js", "/settings.js": "settings.js", "/notes.js": "notes.js",
               "/decor.js": "decor.js", "/dragon.js": "dragon.js",
               "/arrivals.js": "arrivals.js", "/chat.js": "chat.js", "/chat-logic.js": "chat-logic.js",
               "/markdown.js": "markdown.js", "/placement.js": "placement.js",
               "/eva-logo.png": "eva-logo.png",
               "/terminal.js": "terminal.js", "/xterm.js": "xterm.js", "/xterm.css": "xterm.css", "/xterm-fit.js": "xterm-fit.js",
               "/grid.js": "grid.js", "/gridstack.js": "gridstack.js", "/gridstack.css": "gridstack.css"}


def board_version(board_dir: Path = BOARD_DIR) -> str:
    """A mark that changes whenever a file of the board page changes, so an open board knows to load
    itself again rather than run old code."""
    stamps = []
    for name in sorted(set(BOARD_FILES.values())):
        try:
            stat = (board_dir / name).stat()
            stamps.append(f"{name}:{stat.st_mtime_ns}:{stat.st_size}")
        except OSError:
            stamps.append(f"{name}:-")
    return hashlib.sha1("|".join(stamps).encode()).hexdigest()[:12]


def read_sessions(directory: Path, limit: int = MAX_SESSIONS) -> list:
    """Every readable snapshot, newest first. Nothing ages out: the person removes what they are done with."""
    if not directory.is_dir():
        return []
    files = []
    for path in directory.glob("*.json"):
        try:
            info = path.stat()
        except OSError:
            continue
        if info.st_size <= MAX_FILE_BYTES:
            files.append((info.st_mtime, path))
    sessions = []
    for _, path in sorted(files, reverse=True)[:limit]:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and data.get("version") == SNAPSHOT_VERSION:
            sessions.append(data)
    sessions.sort(key=lambda s: s.get("updatedAt", 0), reverse=True)
    return sessions


class Removals:
    """Sessions the person took off the board, and when. A session comes back once a new turn starts in it."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()

    def load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        removed = data.get("removed") if isinstance(data, dict) else None
        if not isinstance(removed, dict):
            return {}
        return {key: at for key, at in removed.items() if SAFE_ID.match(key) and isinstance(at, (int, float))}

    def remove(self, session_id: str, now_ms: int):
        with self.lock:
            removed = self.load()
            removed[session_id] = now_ms
            self._save(removed)

    def forget(self, session_ids):
        if not session_ids:
            return
        with self.lock:
            removed = self.load()
            for session_id in session_ids:
                removed.pop(session_id, None)
            self._save(removed)

    def _save(self, removed: dict):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"removed": removed}), encoding="utf-8")
        temporary.replace(self.path)


def split_removed(sessions: list, removed: dict):
    """Shown sessions, the removed ones (kept for today's spend), and those back because the person wrote
    in them since: a turn started, or a prompt went in mid-turn (which starts no turn of its own)."""
    shown, hidden, back = [], [], []
    for session in sessions:
        session_id = session.get("sessionId")
        removed_at = removed.get(session_id)
        if removed_at is None:
            shown.append(session)
            continue
        turn = session.get("turn") if isinstance(session.get("turn"), dict) else {}
        started = max((at for at in (turn.get("startedAt"), session.get("lastPromptAt")) if isinstance(at, (int, float))), default=None)
        if started is not None and started > removed_at:
            shown.append(session)
            back.append(session_id)
        else:
            hidden.append({"sessionId": session_id, "today": session.get("today")})
    return shown, hidden, back


class Pins:
    """Conversations the person added to the board from Claude's history ("+", From an existing
    conversation). One with no snapshot of its own yet shows as a sleeping card read from its
    transcript, until it runs with CCC and its own snapshot takes over."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()

    def load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        pinned = data.get("pinned") if isinstance(data, dict) else None
        if not isinstance(pinned, dict):
            return {}
        return {key: at for key, at in pinned.items() if SAFE_ID.match(key) and isinstance(at, (int, float))}

    def add(self, session_id: str, now_ms: int):
        with self.lock:
            pinned = self.load()
            pinned[session_id] = now_ms
            self._save(pinned)

    def drop(self, session_id: str):
        with self.lock:
            pinned = self.load()
            if pinned.pop(session_id, None) is not None:
                self._save(pinned)

    def _save(self, pinned: dict):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"pinned": pinned}), encoding="utf-8")
        temporary.replace(self.path)


class Caveman:
    """Caveman mode as the person switches it in CCC: one file per session that has a choice of its
    own, and `default.json` for every session that has none. The mod of each session reads them
    before each request to Claude and adds the caveman rules to its system prompt while it is on."""

    def __init__(self, folder: Path):
        self.folder = folder
        self.lock = threading.Lock()

    def choices(self) -> dict:
        """The default level, and each session's own: {"default": "off", "sessions": {id: level}}."""
        sessions = {}
        default = "off"
        try:
            files = list(self.folder.glob("*.json"))
        except OSError:
            files = []
        for path in files:
            level = self._level_in(path)
            if level is None:
                continue
            if path.stem == "default":
                default = level
            elif SAFE_ID.match(path.stem):
                sessions[path.stem] = level
        return {"default": default, "sessions": sessions}

    def choose(self, session_id, level: str):
        """Sets a session's level, or the default when `session_id` is None. A session set to the
        default's level keeps no file, so it follows the default from then on; one switched off keeps
        its file, so its mod can tell Claude it is off even after the session restarts."""
        with self.lock:
            self.folder.mkdir(parents=True, exist_ok=True)
            if session_id is None:
                self._write(self.folder / "default.json", level)
                return
            target = self.folder / f"{session_id}.json"
            if level == self.choices()["default"] and level != "off":
                target.unlink(missing_ok=True)
            else:
                self._write(target, level)

    def _write(self, target: Path, level: str):
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps({"level": level}), encoding="utf-8")
        temporary.replace(target)

    @staticmethod
    def _level_in(path: Path):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        level = data.get("level") if isinstance(data, dict) else None
        return level if level in CAVEMAN_LEVELS else None


def read_caveman_request(body: bytes):
    """(session id or None for the default, level), or None when the request is not one."""
    data = json_object(body)
    if data is None or data.get("level") not in CAVEMAN_LEVELS:
        return None
    session_id = data.get("sessionId")
    if session_id is None:
        return None, data["level"]
    if not isinstance(session_id, str) or not SAFE_ID.match(session_id):
        return None
    return session_id, data["level"]


def sleeping_card(session_id: str, transcripts, pinned_at: int):
    """The card of an added conversation that has no snapshot: read from its transcript, asleep
    (ended), with no work of its own to show. A message written to it waits in its inbox and goes in
    once it runs with CCC; one in the Claude app or VS Code is woken by the message."""
    path = transcripts.find(session_id)
    if path is None:
        return None
    try:
        info = path.stat()
    except OSError:
        return None
    facts = dict(transcripts.describe(session_id))
    facts.pop("endedTasks", None)
    folder = folder_of(path)
    modified = int(info.st_mtime * 1000)
    last_prompt = facts.get("lastPromptAt")
    return {
        **facts,
        "sessionId": session_id,
        "takesMessages": True,
        "isAdded": True,
        "startedAt": pinned_at,
        "folder": os.path.basename(folder) if folder else "",
        **({"folderPath": folder} if folder else {}),
        "title": facts.get("title") or first_prompt(path) or "Conversation",
        "turn": {"isRunning": False, "startedAt": last_prompt if isinstance(last_prompt, (int, float)) else modified, "endedAt": modified},
        "plan": [],
        "runs": [],
        "log": [],
        "context": None,
        "stats": {"model": "", "costHistory": [], "limits": []},
        "tools": {},
        "today": None,
        "chat": [],
        "reply": None,
        "updatedAt": modified,
        "endedAt": modified,
    }


def with_added(sessions: list, hidden: list, pins: dict, transcripts) -> list:
    """The sessions with a sleeping card for each added conversation that has no snapshot of its own."""
    known = {session.get("sessionId") for session in sessions} | {entry.get("sessionId") for entry in hidden}
    cards = [card for session_id, at in pins.items() if session_id not in known for card in [sleeping_card(session_id, transcripts, int(at))] if card]
    return sessions + cards


def first_prompt(path: Path) -> str:
    """The first thing the person wrote in a transcript, cut short: a name for a conversation the
    Claude app never named."""
    for line in read_bytes(path, 0, 512 * 1024).split(b"\n"):
        if b'"user"' not in line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict) or record.get("type") != "user" or record.get("isMeta"):
            continue
        content = record.get("message", {}).get("content") if isinstance(record.get("message"), dict) else None
        texts = [content] if isinstance(content, str) else [part.get("text") for part in content if isinstance(part, dict) and isinstance(part.get("text"), str)] if isinstance(content, list) else []
        text = SYSTEM_BLOCK.sub("", " ".join(texts)).strip()
        text = command_line(text) or text
        if text and not text.startswith("<"):
            return " ".join(text.split())[:120]
    return ""


EXISTING_SHOWN = 60


def existing_conversations(projects_dir: Path, transcripts, app_ids: dict, on_board: set, limit: int = EXISTING_SHOWN) -> list:
    """The conversations in Claude's history on this Mac, the most recent first, for "+" to add
    to the board: each with its name, its folder, when it was last written in and where it lives."""
    files = []
    for folder, _dirs, names in os.walk(projects_dir):
        if "subagents" in Path(folder).parts:
            continue
        for name in names:
            if name.endswith(".jsonl") and SAFE_ID.match(name[:-6]):
                path = Path(folder) / name
                try:
                    info = path.stat()
                except OSError:
                    continue
                if info.st_size > 0:
                    files.append((info.st_mtime, path))
    found = []
    for mtime, path in sorted(files, reverse=True)[: limit * 2]:
        session_id = path.name[:-6]
        facts = transcripts.describe(session_id)
        title = facts.get("title") or first_prompt(path)
        if not title:
            continue
        folder = folder_of(path) or ""
        app_id = app_ids.get(session_id)
        where = "app" if app_id else ("vscode" if facts.get("entrypoint") == "claude-vscode" else "terminal")
        found.append({"sessionId": session_id, "title": title, "folder": folder, "modifiedAt": int(mtime * 1000), "where": where, **({"appSessionId": app_id} if app_id else {}), "onBoard": session_id in on_board})
        if len(found) >= limit:
            break
    return found


class Transcripts:
    """Reads what the Claude app keeps in a session's own transcript: its name, its permission mode
    and the background work Claude Code reported as ended."""

    def __init__(self, projects_dir: Path):
        self.projects_dir = projects_dir
        self.paths = {}
        self.cache = {}
        self.tasks = {}

    def describe(self, session_id: str) -> dict:
        if not isinstance(session_id, str) or not SAFE_ID.match(session_id):
            return {}
        path = self.find(session_id)
        if path is None:
            return {}
        try:
            info = path.stat()
        except OSError:
            self.paths.pop(session_id, None)
            return {}
        key = (info.st_size, info.st_mtime_ns)
        cached = self.cache.get(session_id)
        if cached and cached[0] == key:
            found = cached[1]
        else:
            found = read_transcript_facts(path, info.st_size)
            self.cache[session_id] = (key, found)
        ended = self.ended_tasks(session_id, path, info.st_size)
        return {**found, "endedTasks": ended} if ended else found

    def ended_tasks(self, session_id: str, path: Path, size: int) -> dict:
        """Every report of ended work in the whole transcript, however long ago. Read once from the
        start, then only what was added since, so a report never falls out of view."""
        offset, ended = self.tasks.get(session_id, (0, {}))
        if size < offset:
            offset, ended = 0, {}
        if size > offset:
            start = max(offset, size - WHOLE_FILE_LIMIT)
            chunk = read_bytes(path, start, size - start)
            end = chunk.rfind(b"\n") + 1
            if end > 0:
                ended = {**ended, **ended_tasks_in(chunk[:end].decode("utf-8", errors="replace"))}
                offset = start + end
        self.tasks[session_id] = (offset, ended)
        return ended

    def find(self, session_id: str):
        path = self.paths.get(session_id)
        if path is not None and path.exists():
            return path
        matches = sorted(self.projects_dir.glob(f"*/{session_id}.jsonl")) if self.projects_dir.is_dir() else []
        path = matches[0] if matches else None
        if path is not None:
            self.paths[session_id] = path
        return path


def read_transcript_facts(path: Path, size: int) -> dict:
    """The newest name and permission mode in a transcript: its tail first, the whole file if needed."""
    facts = facts_in(read_tail(path, size, TAIL_BYTES))
    if ("title" not in facts or "permissionMode" not in facts) and TAIL_BYTES < size <= WHOLE_FILE_LIMIT:
        facts = {**facts_in(read_tail(path, size, size)), **facts}
    return facts


def read_tail(path: Path, size: int, length: int) -> str:
    return read_bytes(path, max(0, size - length), length).decode("utf-8", errors="replace")


def read_bytes(path: Path, start: int, length: int) -> bytes:
    try:
        with path.open("rb") as handle:
            handle.seek(start)
            return handle.read(length)
    except OSError:
        return b""


def facts_in(text: str) -> dict:
    """The last name record (whole JSON lines only), the last permission mode, and where the session
    was started (the Claude app, VS Code, a terminal), as Claude Code writes it on each record."""
    facts = {}
    for line in reversed(text.splitlines()):
        if "custom-title" not in line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        title = record.get("customTitle") if isinstance(record, dict) and record.get("type") == "custom-title" else None
        if isinstance(title, str) and title.strip():
            facts["title"] = title.strip()[:200]
            break
    modes = MODE_FIELD.findall(text)
    if modes:
        facts["permissionMode"] = modes[-1]
    entries = ENTRY_FIELD.findall(text)
    if entries:
        facts["entrypoint"] = entries[-1]
    prompted = last_prompt_at(text)
    if prompted is not None:
        facts["lastPromptAt"] = prompted
    return facts


def last_prompt_at(text: str):
    """When the person last wrote in the session: a prompt of its own, or one taken in mid-turn."""
    for line in reversed(text.splitlines()):
        if '"user"' not in line and "queued_command" not in line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict) or record.get("isMeta") or record.get("isSidechain"):
            continue
        message = record.get("message") if isinstance(record.get("message"), dict) else {}
        attachment = record.get("attachment") if isinstance(record.get("attachment"), dict) else {}
        is_prompt = record.get("type") == "user" and any(item["kind"] == "you" for item in user_items(message.get("content"), None))
        is_taken_in = record.get("type") == "attachment" and attachment.get("type") == "queued_command"
        if is_prompt or is_taken_in:
            return time_of(record.get("timestamp"))
    return None


def ended_tasks_in(text: str) -> dict:
    """Background work Claude Code reported as ended, by the tool call that started it. Only its
    own reports count: a prompt to the session that opens with the report, not a text quoting one.
    A report that comes while Claude works is taken in mid-turn, as a queued prompt (an attachment)."""
    ended = {}
    for line in text.splitlines():
        if "<task-notification>" not in line:
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict):
            continue
        attachment = record.get("attachment") if isinstance(record.get("attachment"), dict) else {}
        if record.get("type") == "user":
            prompt = prompt_text(record.get("message"))
        elif record.get("type") == "attachment" and attachment.get("type") == "queued_command":
            prompt = prompt_text({"content": attachment.get("prompt")})
        else:
            continue
        if not prompt.lstrip().startswith("<task-notification>"):
            continue
        for body in NOTIFICATION.findall(prompt):
            tool_use_id = tag_of(body, "tool-use-id")
            status = TASK_END.get(tag_of(body, "status") or "")
            if tool_use_id and status:
                ended[tool_use_id] = {"status": status, "at": time_of(record.get("timestamp"))}
    return ended


def prompt_text(message) -> str:
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content if isinstance(part, dict) and isinstance(part.get("text"), str))
    return ""


def tag_of(body: str, tag: str):
    found = re.search(rf"<{tag}>([^<]*)</{tag}>", body)
    return found.group(1).strip() or None if found else None


def time_of(stamp):
    """An ISO time from the transcript as milliseconds, or None."""
    try:
        return int(datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def settle_runs(runs: list, ended: dict) -> list:
    """Runs the transcript reports as ended, shown as ended: an open run it names, and the agents of
    a named workflow still marked as working. A safety net beside the mod, which settles them as the
    report arrives; it covers a session on an older mod, or a report the mod missed."""
    settled = []
    for run in runs:
        status = run.get("status") if isinstance(run, dict) else None
        end = ended.get(run.get("id")) if status in ("running", "started") else None
        if end is None and status == "running":
            end = ended.get(run.get("parentId"))
        if end is None:
            settled.append(run)
            continue
        settled.append({**run, "status": end["status"], **({"endedAt": end["at"]} if end["at"] else {})})
    return settled


class UsageLedger:
    """What was used per day across every transcript on this Mac: the tokens Claude used (all
    sessions, their subagents and closed sessions too) and the prompts the person wrote to each
    session. Each file is read once, then only what is added to it. A reply is written as several
    lines that repeat its usage, so each message counts once, by its id; a prompt once, by its own."""

    def __init__(self, projects_dir: Path, refresh_s: float = TOKEN_REFRESH_S):
        self.projects_dir = projects_dir
        self.refresh_s = refresh_s
        self.offsets = {}
        self.messages = {}
        self.prompts = {}
        self.read_at = None
        self.lock = threading.Lock()

    def summary(self, now: float) -> dict:
        with self.lock:
            self.refresh(now)
            return {**token_summary(self.messages.values(), now), "prompts": prompts_today(self.prompts.values(), now)}

    def history(self, now: float, days: int) -> dict:
        with self.lock:
            self.refresh(now)
            return token_history(self.messages.values(), now, days)

    def refresh(self, now: float):
        if self.read_at is None or now - self.read_at >= self.refresh_s:
            self.read_new(day_start(now, TOKEN_HISTORY_DAYS - 1))
            self.read_at = now

    def read_new(self, since: float):
        self.messages = {key: used for key, used in self.messages.items() if used[0] >= since}
        self.prompts = {key: prompt for key, prompt in self.prompts.items() if prompt[0] >= since}
        offsets = {}
        for path, size in transcript_files(self.projects_dir, since):
            start = self.offsets.get(path, 0)
            if start > size:
                start = 0
            offsets[path] = start + self.read_file(path, start, size, since)
        self.offsets = offsets

    def read_file(self, path: Path, start: int, size: int, since: float) -> int:
        """Reads whole lines from start up to size; how many bytes it read."""
        done = 0
        rest = b""
        try:
            with path.open("rb") as handle:
                handle.seek(start)
                left = size - start
                while left > 0:
                    chunk = handle.read(min(TOKEN_CHUNK_BYTES, left))
                    if not chunk:
                        break
                    left -= len(chunk)
                    lines = (rest + chunk).split(b"\n")
                    rest = lines.pop()
                    for line in lines:
                        done += len(line) + 1
                        self.count(line, since)
        except OSError:
            pass
        return done

    def count(self, line: bytes, since: float):
        if b'"usage"' not in line:
            if b'"user"' in line or b'"queued_command"' in line:
                prompt = prompt_of(line)
                if prompt is not None and prompt[1][0] >= since:
                    self.prompts[prompt[0]] = prompt[1]
            return
        used = usage_of(line)
        if used is None or used[1][0] < since:
            return
        key, (at, given, written, cached) = used
        earlier = self.messages.get(key)
        if earlier:
            at, given, written, cached = earlier[0], max(given, earlier[1]), max(written, earlier[2]), max(cached, earlier[3])
        self.messages[key] = (at, given, written, cached)


def transcript_files(projects_dir: Path, since: float):
    """Every transcript changed since the given time, with its size: sessions and their subagents."""
    for folder, _dirs, names in os.walk(projects_dir):
        for name in names:
            if not name.endswith(".jsonl"):
                continue
            path = Path(folder) / name
            try:
                stat = path.stat()
            except OSError:
                continue
            if stat.st_mtime >= since:
                yield path, stat.st_size


def usage_of(line: bytes):
    """A reply's id with when it came and the tokens it used: (seconds, input, output, cached).

    Input is the new text Claude read, written to its cache or not; cached is the text it read
    again from the cache. None for any other line."""
    try:
        record = json.loads(line)
    except ValueError:
        return None
    if not isinstance(record, dict) or record.get("type") != "assistant":
        return None
    message = record.get("message")
    usage = message.get("usage") if isinstance(message, dict) else None
    at = time_of(record.get("timestamp"))
    if not isinstance(usage, dict) or at is None:
        return None
    key = message.get("id") or record.get("requestId") or record.get("uuid")
    if not isinstance(key, str):
        return None
    given = token_count(usage, "input_tokens") + token_count(usage, "cache_creation_input_tokens")
    return key, (at / 1000, given, token_count(usage, "output_tokens"), token_count(usage, "cache_read_input_tokens"))


NOT_A_PROMPT = ("<task-notification>", "<local-command", "<side-sessions-event>", "<ci-monitor-event>", "[Request interrupted", "Caveat:")


def prompt_of(line: bytes):
    """A prompt the person wrote, by its own id: (seconds, session id). What Claude Code itself put
    in the person's place (a step's result, a report of background work, a summary after compacting,
    an interruption, a subagent's prompt) is no prompt. A prompt taken in while Claude works is."""
    if b'"tool_use_id"' in line:
        return None
    try:
        record = json.loads(line)
    except ValueError:
        return None
    if not isinstance(record, dict) or record.get("isSidechain") or record.get("isMeta") or record.get("isCompactSummary"):
        return None
    attachment = record.get("attachment") if isinstance(record.get("attachment"), dict) else {}
    if record.get("type") == "user":
        content = record.get("message", {}).get("content") if isinstance(record.get("message"), dict) else None
    elif record.get("type") == "attachment" and attachment.get("type") == "queued_command":
        content = attachment.get("prompt")
    else:
        return None
    text = SYSTEM_BLOCK.sub("", prompt_text({"content": content})).strip()
    # a prompt of images alone is a prompt too
    if not text and isinstance(content, list) and any(isinstance(part, dict) and part.get("type") == "image" for part in content):
        text = "[image]"
    at = time_of(record.get("timestamp"))
    key, session_id = record.get("uuid"), record.get("sessionId")
    if not text or text.startswith(NOT_A_PROMPT) or at is None or not isinstance(key, str) or not isinstance(session_id, str) or not SAFE_ID.match(session_id):
        return None
    return key, (at / 1000, session_id)


def prompts_today(prompts, now: float) -> dict:
    """How many prompts the person wrote today, to each session and in all."""
    today = day_start(now, 0)
    counts = {}
    for at, session_id in prompts:
        if at >= today:
            counts[session_id] = counts.get(session_id, 0) + 1
    return {"bySession": counts, "total": sum(counts.values())}


def token_count(usage: dict, field: str) -> int:
    value = usage.get(field)
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def day_start(now: float, days_back: int = 0) -> float:
    """Local midnight, days_back days before the day of now, in seconds."""
    day = datetime.fromtimestamp(now).date() - timedelta(days=days_back)
    return datetime(day.year, day.month, day.day).timestamp()


def token_summary(messages, now: float) -> dict:
    """Today's and yesterday's tokens by kind, and per local hour (all kinds together)."""
    today, yesterday = day_start(now, 0), day_start(now, 1)
    days = {"today": [0, 0, 0], "yesterday": [0, 0, 0]}
    hours = {"today": [0] * 24, "yesterday": [0] * 24}
    for at, given, written, cached in messages:
        day = "today" if at >= today else "yesterday" if at >= yesterday else None
        if day is None:
            continue
        sums = days[day]
        sums[0] += given
        sums[1] += written
        sums[2] += cached
        hours[day][datetime.fromtimestamp(at).hour] += given + written + cached

    def kinds(sums):
        return {"input": sums[0], "output": sums[1], "cached": sums[2], "total": sum(sums)}

    return {"today": kinds(days["today"]), "yesterday": kinds(days["yesterday"]), "hours": hours, "hour": datetime.fromtimestamp(now).hour}


def token_history(messages, now: float, days: int) -> dict:
    """Tokens by kind for each of the last `days` local days, oldest first, and today's per hour by
    kind; with the first day any transcript still holds, since Claude Code clears old ones."""
    days = max(1, min(TOKEN_HISTORY_DAYS, int(days)))
    first = day_start(now, days - 1)
    names = [(datetime.fromtimestamp(first) + timedelta(days=i)).date().isoformat() for i in range(days)]
    sums = {name: [0, 0, 0] for name in names}
    today = day_start(now, 0)
    hours = [[0, 0, 0] for _ in range(24)]
    earliest = None
    for at, given, written, cached in messages:
        earliest = at if earliest is None else min(earliest, at)
        if at < first:
            continue
        day = sums.get(datetime.fromtimestamp(at).date().isoformat())
        if day is None:
            continue
        for i, value in enumerate((given, written, cached)):
            day[i] += value
        if at >= today:
            for i, value in enumerate((given, written, cached)):
                hours[datetime.fromtimestamp(at).hour][i] += value

    def kinds(values):
        return {"input": values[0], "output": values[1], "cached": values[2], "total": sum(values)}

    return {
        "days": [{"day": name, **kinds(sums[name])} for name in names],
        "hours": [kinds(values) for values in hours],
        "hour": datetime.fromtimestamp(now).hour,
        "firstDay": datetime.fromtimestamp(earliest).date().isoformat() if earliest is not None else None,
    }


class AppSessions:
    """The Claude app's own id for each of its code sessions (`local_…`), by the session id the board
    knows, read from the small file the app keeps per session; it lets a card open its chat in the app."""

    def __init__(self, directory: Path):
        self.directory = directory
        self.cache = {}

    def ids(self) -> dict:
        if not self.directory.is_dir():
            return {}
        found = {}
        for path in sorted(self.directory.glob("*/*/local_*.json"))[:MAX_APP_SESSIONS]:
            pair = self.read(path)
            if pair:
                found[pair[0]] = pair[1]
        return found

    def read(self, path: Path):
        try:
            mtime = path.stat().st_mtime_ns
        except OSError:
            return None
        cached = self.cache.get(path)
        if cached and cached[0] == mtime:
            return cached[1]
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = None
        cli_id = data.get("cliSessionId") if isinstance(data, dict) else None
        app_id = data.get("sessionId") if isinstance(data, dict) else None
        pair = None
        if isinstance(cli_id, str) and SAFE_ID.match(cli_id) and isinstance(app_id, str) and APP_SESSION_ID.match(app_id):
            pair = (cli_id, app_id)
        self.cache[path] = (mtime, pair)
        return pair


# ---------- the chat of a session, as the big chat window shows it ----------

def read_chat(path: Path, chunk: int = CHAT_CHUNK_BYTES) -> list:
    """The latest exchanges of a transcript: what the person wrote, what Claude answered, and a short
    line for each step Claude took. Read back from the end until CHAT_ITEMS of them are found or the
    file starts, so screenshots cannot crowd them out. Only the records the chat reads are held, and
    without their images: the chat window asks for those again by their line's place."""
    lines, offsets, found = [], [], 0
    for offset, raw in lines_from_end(path, chunk):
        line = PAYLOAD.sub(rb'\1"', raw).decode("utf-8", errors="replace")
        if chat_record(line) is None:
            continue
        lines.append(line)
        offsets.append(offset)
        found += shown_items(line)
        if found >= CHAT_ITEMS:
            break
    return conversation(lines[::-1], offsets[::-1])


def lines_from_end(path: Path, chunk: int = CHAT_CHUNK_BYTES, longest: int = MAX_LINE_BYTES):
    """(offset, bytes) of each line of a file, the last one first, read back a chunk at a time. A line
    longer than `longest` is passed over, so memory stays small however big the file grows."""
    try:
        with path.open("rb") as handle:
            end = handle.seek(0, os.SEEK_END)
            rest, held = [], 0  # the end of the line whose start is not read yet, last piece first
            while end > 0:
                start = max(0, end - chunk)
                handle.seek(start)
                data = handle.read(end - start)
                stop = len(data)
                newline = data.rfind(b"\n", 0, stop)
                while newline >= 0:
                    if held + stop - newline - 1 <= longest:
                        yield start + newline + 1, data[newline + 1:stop] + b"".join(reversed(rest))
                    rest, held, stop = [], 0, newline
                    newline = data.rfind(b"\n", 0, stop)
                held += stop
                rest = rest + [data[:stop]] if held <= longest else []
                end = start
            if held <= longest:
                yield 0, b"".join(reversed(rest))
    except OSError:
        return


def shown_items(line: str) -> int:
    """How many chat items one line gives on its own. A prompt waiting in the queue is not counted:
    a later line may take it out again."""
    return sum(1 for item in conversation([line]) if not item.get("queued"))


def chat_record(line: str):
    """The record of a line when the chat reads it: the main thread's prompts, answers, steps and
    queue. None for the rest, such as an agent's own steps, API logs and file snapshots."""
    try:
        record = json.loads(line)
    except ValueError:
        return None
    if not isinstance(record, dict) or record.get("isSidechain") or record.get("isMeta"):
        return None
    return record if record.get("type") in ("user", "assistant", "attachment", "queue-operation") else None


def conversation(lines, offsets=None) -> list:
    """The exchanges in order. What the person writes while Claude works is kept as a queued prompt
    the turn takes in (an attachment), not as a message of its own, so it is read from there too; and
    what still waits in the queue comes last, marked as queued."""
    items = []
    queue = []
    asked = {}
    for index, line in enumerate(lines):
        record = chat_record(line)
        if record is None:
            continue
        message = record.get("message") if isinstance(record.get("message"), dict) else {}
        at = time_of(record.get("timestamp"))
        kind = record.get("type")
        if kind == "user":
            for block in message.get("content") if isinstance(message.get("content"), list) else []:
                if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("tool_use_id") in asked:
                    answer_question(asked.pop(block["tool_use_id"]), block, record)
            pictures = image_refs(message.get("content"), offsets[index] if offsets else None)
            items.extend(with_pictures(user_items(message.get("content"), at), pictures, at))
        elif kind == "assistant":
            found = assistant_items(message.get("content"), at, record.get("thinkingDisplay") == "updates")
            asked.update({item["toolId"]: item for item in found if item["kind"] == "question" and "toolId" in item})
            items.extend(found)
        elif kind == "attachment" and isinstance(record.get("attachment"), dict) and record["attachment"].get("type") == "queued_command":
            items.extend(user_items(record["attachment"].get("prompt"), at))
        elif kind == "queue-operation":
            follow_queue(queue, record, at)
    waiting = [{**item, "queued": True} for entry in queue for item in user_items(entry["content"], entry["at"])]
    return (items + waiting)[-CHAT_ITEMS:]


def image_blocks(content):
    """The images of a message, in order: its own, then those inside the results of Claude's steps."""
    found = []
    for part in content if isinstance(content, list) else []:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "image":
            found.append(("you", part))
        elif part.get("type") == "tool_result":
            found.extend(("step", inner) for inner in part.get("content") or [] if isinstance(inner, dict) and inner.get("type") == "image")
    return [(whose, block) for whose, block in found if isinstance(block.get("source"), dict) and block["source"].get("type") == "base64" and block["source"].get("media_type") in IMAGE_TYPES]


def image_refs(content, offset):
    """How the chat window asks for each image of a message again: the line's place and the image's number."""
    if offset is None:
        return []
    return [(whose, f"{offset}:{number}") for number, (whose, _) in enumerate(image_blocks(content))]


def with_pictures(items: list, pictures: list, at) -> list:
    """The person's own images go with their message; the images Claude looked at get a row of their own."""
    own = [ref for whose, ref in pictures if whose == "you"]
    seen = [ref for whose, ref in pictures if whose == "step"]
    if own:
        for item in items:
            if item["kind"] == "you":
                item["pictures"] = own
                item["images"] = max(item["images"], len(own))
        if not items:
            items = [{"kind": "you", "text": "", "images": len(own), "pictures": own, "at": at}]
    return items + ([{"kind": "image", "pictures": seen, "at": at}] if seen else [])


def read_picture(path: Path, ref: str):
    """(media type, bytes) of the image a ref names, read straight from its line of the transcript."""
    match = re.fullmatch(r"(\d{1,15}):(\d{1,4})", ref or "")
    if not match:
        return None
    offset, number = int(match.group(1)), int(match.group(2))
    try:
        size = path.stat().st_size
    except OSError:
        return None
    if offset >= size:
        return None
    line = read_bytes(path, offset, min(size - offset, MAX_LINE_BYTES)).split(b"\n", 1)[0]
    try:
        record = json.loads(line.decode("utf-8", errors="replace"))
    except ValueError:
        return None
    message = record.get("message") if isinstance(record, dict) and isinstance(record.get("message"), dict) else {}
    blocks = image_blocks(message.get("content"))
    if number >= len(blocks):
        return None
    source = blocks[number][1]["source"]
    try:
        content = base64.b64decode(source.get("data", ""), validate=True)
    except (binascii.Error, ValueError):
        return None
    extension = IMAGE_TYPES[source["media_type"]]
    return (source["media_type"], content) if looks_like(extension, content) else None


def read_upload(uploads_dir: Path, session_id: str, name: str):
    """(media type, bytes) of an image the person sent from CCC, kept in the uploads folder."""
    if not SAFE_ID.match(session_id or "") or not re.fullmatch(r"[0-9]{1,16}-[0-9a-f]{1,32}-[0-9]{1,2}\.(png|jpg|gif|webp)", name or ""):
        return None
    path = uploads_dir / session_id / name
    try:
        content = path.read_bytes()
    except OSError:
        return None
    extension = name.rsplit(".", 1)[1]
    media = {value: key for key, value in IMAGE_TYPES.items()}[extension]
    return (media, content) if looks_like(extension, content) else None


def read_step(path: Path, tool_id: str):
    """One step Claude took, in full: the tool, what it was given, and what came back. Looked up by
    the call's id near the end of the transcript, where the chat window's steps are."""
    if not isinstance(tool_id, str) or not TOOL_ID.match(tool_id):
        return None
    try:
        size = path.stat().st_size
    except OSError:
        return None
    start = max(0, size - STEP_SEARCH_BYTES)
    needle = tool_id.encode()
    use, result, saved = None, None, None
    for raw in read_bytes(path, start, size - start).split(b"\n"):
        if needle not in raw:
            continue
        try:
            record = json.loads(raw.decode("utf-8", errors="replace"))
        except ValueError:
            continue
        content = record.get("message", {}).get("content") if isinstance(record, dict) and isinstance(record.get("message"), dict) else None
        for part in content if isinstance(content, list) else []:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "tool_use" and part.get("id") == tool_id:
                use = part
            elif part.get("type") == "tool_result" and part.get("tool_use_id") == tool_id:
                result = part
                # what Claude Code kept of the call: for a change to a file, the change as made in it
                saved = record.get("toolUseResult") if isinstance(record.get("toolUseResult"), dict) else None
    if use is None:
        return None
    name = use.get("name") if isinstance(use.get("name"), str) else "tool"
    diff = saved_diff(name, saved) or step_diff(name, use.get("input"))
    where = step_file(name, use.get("input"), diff)
    return {
        **where,
        "name": name,
        "input": shown_input(use.get("input")),
        "result": shown_result(result),
        "isError": bool(result and result.get("is_error")),
        "isDone": result is not None,
        **({"diff": diff} if diff else {}),
    }


# an opened change shows at most this many of its lines
DIFF_SHOWN_MAX = 600


def diff_lines(old, new) -> list:
    """The lines from `old` to `new` as a diff shows them: each one kept, taken away or added."""
    before, after = lines_in(old), lines_in(new)
    if len(before) > DIFF_LINES_MAX or len(after) > DIFF_LINES_MAX:
        return [{"kind": "del", "text": line} for line in before] + [{"kind": "add", "text": line} for line in after]
    shown = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
        if tag == "equal":
            shown += [{"kind": "same", "text": line} for line in before[i1:i2]]
            continue
        shown += [{"kind": "del", "text": line} for line in before[i1:i2]]
        shown += [{"kind": "add", "text": line} for line in after[j1:j2]]
    return shown


PATCH_KINDS = {"+": "add", "-": "del", " ": "same"}


def saved_diff(name, saved):
    """The change as Claude Code made it in the file, as the app shows it: each part with the lines
    around it, and the line numbers it sits at in the file. None when it kept no such record."""
    if name not in ("Edit", "MultiEdit", "Write") or not isinstance(saved, dict) or not isinstance(saved.get("structuredPatch"), list):
        return None
    parts, left = [], DIFF_SHOWN_MAX
    total = 0
    for hunk in saved["structuredPatch"]:
        if not isinstance(hunk, dict) or not isinstance(hunk.get("lines"), list):
            continue
        old_at = hunk.get("oldStart") if isinstance(hunk.get("oldStart"), int) else 1
        new_at = hunk.get("newStart") if isinstance(hunk.get("newStart"), int) else 1
        part = []
        for line in hunk["lines"]:
            kind = PATCH_KINDS.get(line[:1]) if isinstance(line, str) else None
            if kind is None:
                continue
            total += 1
            # a line taken away has its place in the file before; a kept or added one, after
            number = old_at if kind == "del" else new_at
            old_at += kind != "add"
            new_at += kind != "del"
            if len(part) < left:
                part.append({"kind": kind, "text": line[1:][:2000], "line": number})
        if part:
            parts.append(part)
            left -= len(part)
    if not parts:
        return None
    path = saved.get("filePath")
    return {"file": path[:4096] if isinstance(path, str) else "", "parts": parts, "isCut": total > DIFF_SHOWN_MAX}


def step_file(name, given, diff) -> dict:
    """The file a step touched and the line to open it at: the first line a change made, the line a
    read started at, else the top."""
    if name not in FILE_TOOLS or not isinstance(given, dict):
        return {}
    path = given.get("file_path") or given.get("notebook_path")
    if not isinstance(path, str) or not path.startswith("/"):
        return {}
    changed = [line["line"] for part in (diff or {}).get("parts", []) for line in part if line["kind"] != "same" and isinstance(line.get("line"), int)]
    offset = given.get("offset")
    line = changed[0] if changed else offset if isinstance(offset, int) and offset > 0 else 1
    return {"filePath": path[:4096], "fileLine": line}


def step_diff(name, given):
    """For a step that changed a file, what the app shows when it is opened: the file, and its lines
    with the ones taken away and added marked, one part per change. None for any other step."""
    if name not in ("Edit", "MultiEdit", "Write") or not isinstance(given, dict):
        return None
    if name == "Edit":
        parts = [diff_lines(given.get("old_string"), given.get("new_string"))]
    elif name == "MultiEdit":
        edits = given.get("edits") if isinstance(given.get("edits"), list) else []
        parts = [diff_lines(edit.get("old_string"), edit.get("new_string")) for edit in edits if isinstance(edit, dict)]
    else:
        parts = [diff_lines("", given.get("content"))]
    left = DIFF_SHOWN_MAX
    kept = []
    for part in parts:
        if left <= 0:
            break
        kept.append([{**line, "text": line["text"][:2000]} for line in part[:left]])
        left -= len(part)
    shown_count = sum(len(part) for part in parts)
    path = given.get("file_path")
    return {"file": path[:4096] if isinstance(path, str) else "", "parts": kept, "isCut": shown_count > DIFF_SHOWN_MAX}


def shown_input(given) -> str:
    """What a step was given, readable: the command or file first, then the rest as it came."""
    if not isinstance(given, dict):
        return ""
    lines = []
    for key in ("command", "file_path", "path", "pattern", "url", "description"):
        if isinstance(given.get(key), str) and given[key].strip():
            lines.append(given[key] if key == "command" else f"{key}: {given[key]}")
    rest = {key: value for key, value in given.items() if key not in ("command", "file_path", "path", "pattern", "url", "description")}
    if rest:
        lines.append(json.dumps(rest, ensure_ascii=False, indent=2))
    return "\n".join(lines)[:STEP_TEXT_MAX]


def shown_result(result) -> str:
    """What came back from a step, as text; an image it returned is named, not drawn."""
    if result is None:
        return ""
    content = result.get("content")
    if isinstance(content, str):
        return content[:STEP_TEXT_MAX]
    parts = []
    for part in content if isinstance(content, list) else []:
        if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str):
            parts.append(part["text"])
        elif isinstance(part, dict) and part.get("type") == "image":
            parts.append("[an image]")
    return "\n".join(parts)[:STEP_TEXT_MAX]


def follow_queue(queue: list, record: dict, at):
    """Keeps the prompts that wait for Claude: queued in, taken out as they are sent or taken in mid-turn."""
    operation = record.get("operation")
    if operation == "enqueue" and record.get("content") is not None:
        queue.append({"content": record.get("content"), "at": at})
    elif operation in ("dequeue", "remove") and queue:
        queue.pop(0)


def replies_in(parts) -> list:
    """The person's own words that turned a box down (a tool result in the words the app uses), as
    their messages in the chat."""
    said = []
    for part in parts:
        if part.get("type") != "tool_result":
            continue
        body = part.get("content")
        text = body if isinstance(body, str) else "\n".join(one.get("text", "") for one in body if isinstance(one, dict)) if isinstance(body, list) else ""
        if text.startswith(FEEDBACK) and text[len(FEEDBACK):].strip():
            said.append(text[len(FEEDBACK):].strip())
    return said


def user_items(content, at) -> list:
    if isinstance(content, str):
        texts, images = [content], 0
    elif isinstance(content, list):
        parts = [part for part in content if isinstance(part, dict)]
        replies = replies_in(parts)
        if replies:
            return [{"kind": "you", "text": shown_text(reply), "images": 0, "at": at} for reply in replies]
        texts = [part.get("text") for part in parts if part.get("type") == "text" and isinstance(part.get("text"), str)]
        images = sum(1 for part in parts if part.get("type") == "image")
    else:
        return []
    text = SYSTEM_BLOCK.sub("", "\n".join(texts)).strip()
    text = command_line(text) or text
    sent = SENT_IMAGES.search(text)
    uploads = []
    if sent:
        images += sent.group(1).count("- ")
        uploads = [f"upload:{os.path.basename(line[2:].strip())}" for line in sent.group(1).splitlines() if line.startswith("- ")]
        text = text[: sent.start()].strip()
    files = []
    added = SENT_FILES.search(text)
    if added:
        for line in added.group(1).splitlines():
            if line.startswith("- "):
                name = os.path.basename(line[2:].strip())
                own = SAVED_FILE.match(name)
                files.append(own.group(1) if own else name)
        text = text[: added.start()].strip()
    if text.startswith("<task-notification>"):
        return [{"kind": "note", "text": "Background work reported back", "at": at}]
    if not text and not images and not files:
        return []
    item = {"kind": "you", "text": shown_text(text), "images": images, "at": at}
    if files:
        item["files"] = files
    return [{**item, "pictures": uploads} if uploads else item]


def command_line(text: str):
    """A slash command or skill the person ran, as they typed it ("/caveman ultra"), the way the
    Claude app shows it; None when the text is no such command."""
    name = COMMAND_NAME_TAG.search(text)
    if not name:
        return None
    args = COMMAND_ARGS_TAG.search(text)
    command = name.group(1) if name.group(1).startswith("/") else "/" + name.group(1)
    return f"{command} {args.group(1).strip()}".strip() if args else command


def shown_text(text: str) -> str:
    """A message as the chat shows it: whole, or its start and how much of it is not shown."""
    if len(text) <= CHAT_TEXT_MAX:
        return text
    return f"{text[:CHAT_TEXT_MAX]}\n\n… {spaced(len(text) - CHAT_TEXT_MAX)} more characters, not shown here"


def spaced(number: int) -> str:
    """A count with a space between thousands: 500 000."""
    return f"{number:,}".replace(",", " ")


def assistant_items(content, at, shows_thinking: bool = False) -> list:
    """Claude's words and steps in one record. With `shows_thinking` (the record's thinkingDisplay is
    "updates"), Claude's short notes between steps come as thinking blocks, and the Claude app shows
    them as ordinary text: so does CCC, marked as notes so the board can leave them out."""
    items = []
    for part in content if isinstance(content, list) else []:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text" and isinstance(part.get("text"), str) and part["text"].strip():
            items.append({"kind": "claude", "text": shown_text(part["text"]), "at": at})
        elif shows_thinking and part.get("type") == "thinking" and isinstance(part.get("thinking"), str) and part["thinking"].strip():
            items.append({"kind": "claude", "text": shown_text(part["thinking"].strip()), "at": at, "note": True})
        elif part.get("type") == "tool_use":
            if part.get("name") == QUESTION_TOOL:
                step = question_item(part.get("input"), at)
            else:
                step = {"kind": "tool", "text": describe_tool(part.get("name"), part.get("input")), "at": at, **tool_facts(part.get("name"), part.get("input"))}
            if isinstance(part.get("id"), str) and TOOL_ID.match(part["id"]):
                step["toolId"] = part["id"]
            items.append(step)
    return items


def tool_facts(name, given) -> dict:
    """Which tool a step used, and for a browser batch the actions it ran, so the chat can sum up a
    run of steps in the app's own words ("Ran 2 commands, read a file")."""
    if not isinstance(name, str) or not name:
        return {}
    facts = {"tool": name[:120], **file_facts(name, given)}
    if name.endswith("browser_batch") and isinstance(given, dict) and isinstance(given.get("actions"), list):
        actions = []
        for action in given["actions"][:30]:
            if not isinstance(action, dict) or not isinstance(action.get("name"), str):
                continue
            inner = action.get("input") if isinstance(action.get("input"), dict) else {}
            kind = inner.get("action") if isinstance(inner.get("action"), str) else ""
            actions.append(f"{action['name']}:{kind}"[:60] if kind else action["name"][:60])
        facts["actions"] = actions
    return facts


FILE_TOOLS = ("Read", "Edit", "MultiEdit", "Write", "NotebookEdit")
# a file bigger than this in lines is not compared line by line; its lines are only counted
DIFF_LINES_MAX = 5000


def lines_in(text) -> list:
    return text.splitlines() if isinstance(text, str) else []


def changed_lines(old, new):
    """(lines added, lines taken away) from `old` to `new`, as a diff counts them."""
    before, after = lines_in(old), lines_in(new)
    if len(before) > DIFF_LINES_MAX or len(after) > DIFF_LINES_MAX:
        return len(after), len(before)
    added = removed = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
        if tag in ("replace", "delete"):
            removed += i2 - i1
        if tag in ("replace", "insert"):
            added += j2 - j1
    return added, removed


def file_facts(name, given) -> dict:
    """For a step on a file: its name, and for a change the lines it added and took away, so the
    chat can write "Read and edited integrations.plist +1 -0" as the app does."""
    if name not in FILE_TOOLS or not isinstance(given, dict):
        return {}
    path = given.get("file_path") or given.get("notebook_path")
    facts = {"file": os.path.basename(path)[:120]} if isinstance(path, str) and path else {}
    if name == "Edit":
        added, removed = changed_lines(given.get("old_string"), given.get("new_string"))
    elif name == "MultiEdit" and isinstance(given.get("edits"), list):
        pairs = [changed_lines(edit.get("old_string"), edit.get("new_string")) for edit in given["edits"] if isinstance(edit, dict)]
        added, removed = sum(pair[0] for pair in pairs), sum(pair[1] for pair in pairs)
    elif name == "Write":
        added, removed = len(lines_in(given.get("content"))), 0
    else:
        return facts
    return {**facts, "added": added, "removed": removed}


def question_item(given, at) -> dict:
    """A question box Claude put to the person: each question with its options, as the app shows them."""
    questions = []
    for one in (given.get("questions") if isinstance(given, dict) else None) or []:
        if not isinstance(one, dict) or not isinstance(one.get("question"), str) or not one["question"].strip():
            continue
        options = [
            {"label": str(option.get("label"))[:200], "description": str(option.get("description") or "")[:600]}
            for option in (one.get("options") if isinstance(one.get("options"), list) else [])
            if isinstance(option, dict) and str(option.get("label") or "").strip()
        ][:QUESTION_OPTIONS_MAX]
        questions.append({"question": one["question"][:1000], "header": str(one.get("header") or "")[:40], "multiSelect": one.get("multiSelect") is True, "options": options})
    return {"kind": "question", "questions": questions[:QUESTIONS_MAX], "at": at}


def answer_question(item: dict, block: dict, record: dict):
    """What the person answered, one answer per question, from the result the app recorded; a box
    turned down or cut short is marked so."""
    result = record.get("toolUseResult")
    answers = result.get("answers") if isinstance(result, dict) else None
    if block.get("is_error") or not isinstance(answers, dict):
        item["isDeclined"] = True
        return
    item["answers"] = [str(answers.get(one["question"]) or "")[:ANSWER_MAX] for one in item["questions"]]


def describe_tool(name, given) -> str:
    """One short line for a step Claude took: the command, the file, the search."""
    name = name if isinstance(name, str) else "tool"
    given = given if isinstance(given, dict) else {}
    short = lambda value: str(value).strip().splitlines()[0][:160] if str(value).strip() else ""
    if name == "Bash" and given.get("command"):
        return f"$ {short(given['command'])}"
    if given.get("file_path"):
        return f"{name} {os.path.basename(str(given['file_path']))}"
    if name in ("Grep", "Glob") and given.get("pattern"):
        return f"{name} {short(given['pattern'])}"
    if name in ("Agent", "Task") and given.get("description"):
        return f"Agent: {short(given['description'])}"
    if name.startswith("mcp__"):
        return name.split("__")[-1].replace("_", " ")
    return name


# ---------- messages the person writes in CCC, waiting for their session to take them ----------

SEND_MODES = ("queue", "now")


def read_send_request(body: bytes):
    """((session id, text, images as (extension, bytes), mode, files as (name, bytes)), '') for a
    plain, valid message, else (None, what is wrong). Only real PNG, JPEG, GIF or WebP images go as
    images, each at most MAX_IMAGE_BYTES; any other file goes along as a file, each at most
    MAX_FILE_BYTES. The mode says what happens while Claude works: `queue` waits until it is done,
    `now` stops it and goes in at once; a board that says nothing queues."""
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, "That message could not be read."
    if not isinstance(data, dict):
        return None, "That message could not be read."
    session_id, text, images, files = data.get("sessionId"), data.get("text", ""), data.get("images", []), data.get("files", [])
    mode = data.get("mode", "queue")
    if not isinstance(session_id, str) or not SAFE_ID.match(session_id) or not isinstance(text, str) or not isinstance(images, list) or not isinstance(files, list) or mode not in SEND_MODES:
        return None, "That message could not be read."
    text = text.strip()
    if len(text) > MESSAGE_TEXT_MAX:
        return None, f"The message is too long: {spaced(len(text))} characters, at most {spaced(MESSAGE_TEXT_MAX)}."
    if len(images) > MAX_IMAGES:
        return None, f"At most {MAX_IMAGES} images in one message."
    if len(files) > MAX_FILES:
        return None, f"At most {MAX_FILES} files in one message."
    if not text and not images and not files:
        return None, "There is nothing to send."
    decoded = []
    for image in images:
        extension = IMAGE_TYPES.get(image.get("mediaType")) if isinstance(image, dict) else None
        raw = image.get("data") if isinstance(image, dict) else None
        if extension is None or not isinstance(raw, str) or len(raw) > MAX_IMAGE_BYTES * 4 // 3 + 8:
            return None, "Only PNG, JPEG, GIF and WebP images of at most 10 MB can go along."
        try:
            content = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            return None, "An image could not be read."
        if len(content) > MAX_IMAGE_BYTES or not looks_like(extension, content):
            return None, "Only PNG, JPEG, GIF and WebP images of at most 10 MB can go along."
        decoded.append((extension, content))
    attached = []
    for one in files:
        raw = one.get("data") if isinstance(one, dict) else None
        if not isinstance(raw, str) or len(raw) > MAX_FILE_BYTES * 4 // 3 + 8:
            return None, "A file can be at most 20 MB."
        try:
            content = base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            return None, "A file could not be read."
        if len(content) > MAX_FILE_BYTES:
            return None, "A file can be at most 20 MB."
        attached.append((safe_file_name(one.get("name")), content))
    return (session_id, text, decoded, mode, attached), ""


def session_files(session_id: str, typed: str, transcripts, lists) -> dict:
    """The files of a session's folder that match what was typed after "@", for its write box's menu.
    The folder is the one its transcript names; nothing when that cannot be told."""
    path = transcripts.find(session_id) if isinstance(session_id, str) and SAFE_ID.match(session_id) else None
    folder = folder_of(path) if path else None
    if not folder or not os.path.isdir(folder):
        return {"paths": [], "problem": "Its folder is not known yet."}
    return {"folder": folder, "paths": mentions.matches(mentions.with_folders(lists.files(folder)), typed[:200])}


def read_commands(commands_dir: Path, session_id: str) -> dict:
    """A session's slash commands and the models /model takes, as its mod last wrote them; empty
    lists for a session whose mod has not written them (an older CCC, or not started yet)."""
    empty = {"commands": [], "models": []}
    if not isinstance(session_id, str) or not SAFE_ID.match(session_id):
        return empty
    try:
        data = json.loads((commands_dir / f"{session_id}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return empty
    if not isinstance(data, dict):
        return empty
    commands = []
    for entry in data.get("commands") or []:
        name = entry.get("name") if isinstance(entry, dict) else None
        if isinstance(name, str) and COMMAND_NAME.match(name):
            description = entry.get("description")
            source = entry.get("source")
            commands.append({"name": name, "description": description[:300] if isinstance(description, str) else "", "source": source if isinstance(source, str) else ""})
    models = [model for model in data.get("models") or [] if isinstance(model, str) and COMMAND_NAME.match(model.replace("[", "").replace("]", ""))]
    return {"commands": commands[:COMMANDS_MAX], "models": models[:40]}


def safe_file_name(name) -> str:
    """A dropped file's own name, kept readable but safe to save: no folders, no odd characters."""
    base = os.path.basename(name) if isinstance(name, str) else ""
    clean = re.sub(r"[^A-Za-z0-9._ ()+-]", "_", base).strip(" .")[:FILE_NAME_MAX]
    return clean or "file"


def looks_like(extension: str, content: bytes) -> bool:
    return {
        "png": content.startswith(b"\x89PNG\r\n\x1a\n"),
        "jpg": content.startswith(b"\xff\xd8\xff"),
        "gif": content.startswith((b"GIF87a", b"GIF89a")),
        "webp": content[:4] == b"RIFF" and content[8:12] == b"WEBP",
    }[extension]


class Inbox:
    """Messages written in CCC, one file each, until the session's mod takes them (it leaves a
    `.taken` mark beside the file, and the inbox then clears both). Images go to an uploads folder
    and the message names their paths, so Claude can open them."""

    def __init__(self, inbox_dir: Path, uploads_dir: Path):
        self.inbox_dir = inbox_dir
        self.uploads_dir = uploads_dir

    def send(self, session_id: str, text: str, images: list, mode: str, now_ms: int, files: list = ()) -> str:
        self.clear_taken(session_id)
        message_id = f"{now_ms}-{secrets.token_hex(4)}"
        paths = []
        file_paths = []
        if images or files:
            folder = self.uploads_dir / session_id
            folder.mkdir(parents=True, exist_ok=True)
            for index, (extension, content) in enumerate(images, start=1):
                path = folder / f"{message_id}-{index}.{extension}"
                path.write_bytes(content)
                paths.append(str(path))
            for index, (name, content) in enumerate(files, start=1):
                path = folder / f"{message_id}-f{index}-{name}"
                path.write_bytes(content)
                file_paths.append(str(path))
        folder = self.inbox_dir / session_id
        folder.mkdir(parents=True, exist_ok=True)
        temporary = folder / f"{message_id}.tmp"
        temporary.write_text(json.dumps({"id": message_id, "text": text, "images": paths, "files": file_paths, "mode": mode, "at": now_ms}), encoding="utf-8")
        temporary.replace(folder / f"{message_id}.json")
        return message_id

    def hurry(self, session_id: str, message_id: str, now_ms: int) -> bool:
        """Send now on a message that waits in the queue: it becomes one that stops Claude and goes
        in at once. False when the session has taken it already, or there is no such message."""
        if not SAFE_ID.match(session_id or "") or not re.fullmatch(r"[0-9]{1,16}-[0-9a-f]{1,32}", message_id or ""):
            return False
        folder = self.inbox_dir / session_id
        path = folder / f"{message_id}.json"
        if (folder / f"{message_id}.taken").exists():
            return False
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False
        if not isinstance(data, dict) or data.get("stop"):
            return False
        temporary = folder / f"{message_id}.tmp"
        temporary.write_text(json.dumps({**data, "mode": "now", "at": now_ms}), encoding="utf-8")
        temporary.replace(path)
        return True

    def take_first(self, session_id: str):
        """The oldest message that waits for the session, marked taken as its mod marks one, for a
        session that starts with it; None when nothing waits."""
        folder = self.inbox_dir / session_id
        if not SAFE_ID.match(session_id or "") or not folder.is_dir():
            return None
        for path in sorted(folder.glob("*.json")):
            if path.with_suffix(".taken").exists():
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict) or data.get("stop") or data.get("stopRun"):
                continue
            path.with_suffix(".taken").write_text(str(int(time.time() * 1000)), encoding="utf-8")
            return data
        return None

    def stop_run(self, session_id: str, run_id: str, now_ms: int) -> str:
        """Asks the session to end one agent or background command (Stop on the agent map); its
        turn goes on. The session's mod takes it as it takes a stop."""
        message_id = f"{now_ms}-{secrets.token_hex(4)}"
        folder = self.inbox_dir / session_id
        folder.mkdir(parents=True, exist_ok=True)
        temporary = folder / f"{message_id}.tmp"
        temporary.write_text(json.dumps({"id": message_id, "stopRun": run_id, "at": now_ms}), encoding="utf-8")
        temporary.replace(folder / f"{message_id}.json")
        return message_id

    def stop(self, session_id: str, now_ms: int) -> str:
        """Asks the session to stop Claude's running turn: a message with no words that the session's
        mod takes as a stop. Messages queued before it still go in once Claude has stopped."""
        message_id = f"{now_ms}-{secrets.token_hex(4)}"
        folder = self.inbox_dir / session_id
        folder.mkdir(parents=True, exist_ok=True)
        temporary = folder / f"{message_id}.tmp"
        temporary.write_text(json.dumps({"id": message_id, "stop": True, "at": now_ms}), encoding="utf-8")
        temporary.replace(folder / f"{message_id}.json")
        return message_id

    def clear_taken(self, session_id: str):
        """Removes the messages the session has taken, which can be large: a long message is only
        needed until its session has it."""
        folder = self.inbox_dir / session_id
        if not SAFE_ID.match(session_id) or not folder.is_dir():
            return
        for taken in folder.glob("*.taken"):
            for done in (taken.with_suffix(".json"), taken):
                try:
                    done.unlink()
                except OSError:
                    pass

    def pending(self, session_id: str) -> list:
        """What still waits for the session, oldest first; taken messages are cleared away."""
        folder = self.inbox_dir / session_id
        if not SAFE_ID.match(session_id) or not folder.is_dir():
            return []
        self.clear_taken(session_id)
        waiting = []
        for path in sorted(folder.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(data, dict) and not data.get("stop") and not data.get("stopRun"):
                waiting.append({"id": data.get("id"), "text": str(data.get("text", ""))[:CHAT_TEXT_MAX], "images": len(data.get("images") or []), "files": len(data.get("files") or []), "mode": data.get("mode") if data.get("mode") in SEND_MODES else "queue", "at": data.get("at")})
        return waiting


def chat_payload(session_id: str, transcripts: Transcripts, inbox: Inbox) -> dict:
    """The chat window's view of a session: its exchanges, and what waits to be sent to it."""
    if not isinstance(session_id, str) or not SAFE_ID.match(session_id):
        return {"items": [], "pending": []}
    path = transcripts.find(session_id)
    return {"items": read_chat(path) if path else [], "pending": inbox.pending(session_id)}


# ---------- answers to Claude's question boxes, given in CCC ----------

def read_answer_request(body: bytes):
    """(session id, the box's tool id, one answer per question, or the person's own words instead)
    of a plain request, or None."""
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    session_id, tool_id, answers = data.get("sessionId"), data.get("toolId"), data.get("answers")
    if not isinstance(session_id, str) or not SAFE_ID.match(session_id) or not isinstance(tool_id, str) or not TOOL_ID.match(tool_id):
        return None
    said = data.get("message")
    if said is not None:
        return (session_id, tool_id, said.strip()) if isinstance(said, str) and said.strip() and len(said) <= REPLY_MAX else None
    if not isinstance(answers, list) or not 1 <= len(answers) <= QUESTIONS_MAX:
        return None
    if not all(isinstance(answer, str) and answer.strip() and len(answer) <= ANSWER_MAX for answer in answers):
        return None
    return session_id, tool_id, [answer.strip() for answer in answers]


class Answers:
    """Leaves the person's answer to a question box where the session's PermissionRequest hook
    (answer_from_ccc.py) waits for it; the hook hands it to Claude Code, which takes the box down
    in the app."""

    def __init__(self, answers_dir: Path, transcripts: Transcripts):
        self.dir = answers_dir
        self.transcripts = transcripts

    def give(self, session_id: str, tool_id: str, answers, now_ms: int) -> str:
        """Leaves the answer (one per question, or the person's own words for the whole box); what
        went wrong, or '' when it is on its way."""
        path = self.transcripts.find(session_id)
        box = next((item for item in read_chat(path) if item.get("kind") == "question" and item.get("toolId") == tool_id), None) if path else None
        if box is None:
            return "That question is no longer in the chat."
        if "answers" in box or box.get("isDeclined"):
            return "That question has already been answered."
        texts = [one["question"] for one in box["questions"]]
        if isinstance(answers, str):
            left = {"toolId": tool_id, "questions": texts, "message": answers, "at": now_ms}
        elif len(answers) != len(texts):
            return "Answer every question."
        else:
            left = {"toolId": tool_id, "questions": texts, "answers": dict(zip(texts, answers)), "at": now_ms}
        self.dir.mkdir(parents=True, exist_ok=True)
        target = self.dir / f"{session_id}.json"
        temporary = self.dir / f".{session_id}.{secrets.token_hex(4)}.tmp"
        temporary.write_text(json.dumps(left))
        os.replace(temporary, target)
        return ""


# ---------- approving a call from CCC ----------

BOX_ID = re.compile(r"^[0-9a-f]{16}$")
# a note the hook has not renewed for this long belongs to a hook that is gone
APPROVAL_BEAT_MS = 10_000
APPROVAL_DECISIONS = ("allow", "deny")
APPROVAL_TEXTS = {"description": 300, "command": 20_000, "target": 4_000, "detail": 4_000, "suggested": 100}
# the Claude app's branch question, asked as an approval box: it is answered with the branch picked
APPROVAL_KINDS = ("branch",)
BRANCH_CHOICES = ("new", "stay")


def approval_box(approvals_dir: Path, session_id, now_ms: float):
    """The approval box that the session's hook (approve_from_ccc.py) says waits in front of the
    person right now, with the call it is about, or None."""
    if not isinstance(session_id, str) or not SAFE_ID.match(session_id):
        return None
    try:
        note = json.loads((approvals_dir / f"{session_id}.box.json").read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(note, dict) or not isinstance(note.get("box"), str) or not BOX_ID.match(note["box"]):
        return None
    tool, at, beat = note.get("tool"), note.get("at"), note.get("beat")
    if not isinstance(tool, str) or not 0 < len(tool) <= 100:
        return None
    if not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in (at, beat)) or now_ms - beat > APPROVAL_BEAT_MS:
        return None
    texts = {key: note[key][:limit] for key, limit in APPROVAL_TEXTS.items() if isinstance(note.get(key), str) and note[key]}
    kind = {"kind": note["kind"]} if note.get("kind") in APPROVAL_KINDS else {}
    return {"box": note["box"], "tool": tool, "at": at, **kind, **texts}


def approval_ended_at(approvals_dir: Path, session_id):
    """When the last box the session's hook held open was put up, once it was answered (in CCC, in
    the app, or the turn stopped), or None."""
    if not isinstance(session_id, str) or not SAFE_ID.match(session_id):
        return None
    try:
        at = json.loads((approvals_dir / f"{session_id}.ended.json").read_text()).get("at")
    except (OSError, ValueError, AttributeError):
        return None
    return at if isinstance(at, (int, float)) and not isinstance(at, bool) else None


def approval_text(box: dict) -> str:
    """The box's call on one line, as a card shows the call a session waits on."""
    if "command" in box:
        lines = box["command"].strip().splitlines()
        return f"$ {lines[0] if lines else ''}"[:120]
    return f"{box['tool']} {box.get('target', '')}".strip()[:120]


def with_approval_boxes(sessions: list, approvals_dir: Path, now_ms: float) -> list:
    """Each snapshot whose hook says an approval box waits marked so, with what the box is about.
    The hook runs only while the box is in front of the person, so the box counts as shown; one
    left from a turn that has ended does not count. Once the hook's box was answered, the approval
    the session waited on is over, though the call it allowed may run on for a while."""
    marked = []
    for session in sessions:
        turn = session.get("turn")
        box = approval_box(approvals_dir, session.get("sessionId"), now_ms) if isinstance(turn, dict) and turn.get("isRunning") else None
        waiting = turn.get("waiting") if isinstance(turn, dict) and isinstance(turn.get("waiting"), dict) else {}
        if box is None and waiting.get("kind") == "approval" and isinstance(waiting.get("since"), (int, float)):
            ended = approval_ended_at(approvals_dir, session.get("sessionId"))
            if ended is not None and ended >= waiting["since"]:
                session = {**session, "turn": {key: value for key, value in turn.items() if key != "waiting"}}
        if box is not None:
            waiting = turn.get("waiting") if isinstance(turn.get("waiting"), dict) else {}
            own = waiting if waiting.get("kind") == "approval" else {}
            shown = {**own, "kind": "approval", "since": box["at"], "text": approval_text(box), "isShown": True, "box": box}
            session = {**session, "turn": {**turn, "waiting": shown}}
        marked.append(session)
    return marked


def read_approve_request(body: bytes):
    """(session id, the box's id, 'allow' or 'deny', the branch picked or None) of a plain request, or None."""
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    session_id, box_id, chosen = data.get("sessionId"), data.get("box"), data.get("decision")
    if not isinstance(session_id, str) or not SAFE_ID.match(session_id) or not isinstance(box_id, str) or not BOX_ID.match(box_id):
        return None
    branch = data.get("branch")
    if branch is not None and (branch not in BRANCH_CHOICES or chosen != "allow"):
        return None
    # words written in the chat while the box waited turn it down and tell Claude what to do instead
    said = data.get("message")
    if said is not None and (chosen != "deny" or not isinstance(said, str) or not said.strip() or len(said) > REPLY_MAX):
        return None
    return (session_id, box_id, chosen, branch, said.strip() if said else None) if chosen in APPROVAL_DECISIONS else None


class Approvals:
    """Leaves the person's decision on an approval box where the session's PermissionRequest hook
    (approve_from_ccc.py) waits for it; the hook hands it to Claude Code, which takes the box down
    in the app."""

    def __init__(self, approvals_dir: Path):
        self.dir = approvals_dir

    def give(self, session_id: str, box_id: str, chosen: str, now_ms: int, branch: str = None, said: str = None) -> str:
        """Leaves the decision (and the branch picked, for the branch question); what went wrong,
        or '' when it is on its way."""
        box = approval_box(self.dir, session_id, now_ms)
        if box is None or box["box"] != box_id:
            return "That approval is no longer waiting. It was answered in the app, or Claude moved on."
        if branch is not None and box.get("kind") != "branch":
            return "That box does not ask about a branch."
        target = self.dir / f"{session_id}.answer.json"
        temporary = self.dir / f".{session_id}.{secrets.token_hex(4)}.tmp"
        temporary.write_text(json.dumps({"box": box_id, "decision": chosen, "at": now_ms, **({"branch": branch} if branch else {}), **({"message": said} if said else {})}))
        os.replace(temporary, target)
        return ""


# ---------- starting a Claude Code session from CCC ----------

PASSING_FOLDERS = ("/tmp/", "/private/tmp/", "/private/var/", "/var/folders/", f"{Path.home()}/Library/")


def recent_folders(projects_dir: Path, limit: int = RECENT_FOLDERS, passing: tuple = PASSING_FOLDERS) -> list:
    """The folders Claude Code sessions worked in, the most recent first: each transcript names its
    folder in its first lines. Folders gone since, and the passing ones (temporary folders, the
    Claude app's own scratch places under Library), are left out."""
    files = []
    for folder, _dirs, names in os.walk(projects_dir):
        if "subagents" in Path(folder).parts:
            continue
        for name in names:
            if name.endswith(".jsonl"):
                path = Path(folder) / name
                try:
                    files.append((path.stat().st_mtime, path))
                except OSError:
                    continue
    found = []
    for _, path in sorted(files, reverse=True):
        folder = folder_of(path)
        if folder and folder not in found and not (folder + "/").startswith(passing) and os.path.isdir(folder):
            found.append(folder)
            if len(found) >= limit:
                break
    return found


def folder_of(path: Path):
    """The folder a transcript's session worked in, from its first lines; None when it names none."""
    try:
        head = read_bytes(path, 0, 256 * 1024)
    except OSError:
        return None
    match = CWD_FIELD.search(head)
    if not match:
        return None
    try:
        folder = json.loads(match.group(1).decode("utf-8", errors="replace"))
    except ValueError:
        return None
    return folder if isinstance(folder, str) and folder.startswith("/") else None


CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def read_resume_request(body: bytes, transcripts):
    """(folder, session id) for a plain request to pick a conversation up again in the Terminal, else
    None. The folder is the conversation's own, read from its transcript, never taken from the page."""
    session_id = removal_target(body)
    path = transcripts.find(session_id) if session_id else None
    folder = folder_of(path) if path else None
    if not folder or not os.path.isdir(folder):
        return None
    return os.path.realpath(folder), session_id


def read_start_request(body: bytes):
    """((folder, where, first prompt), '') for a plain request to start a session, else (None, what
    is wrong). The folder must be one on this Mac; where is the Claude app, the Terminal or the
    background. A first prompt goes with each: the app gets it written in its new session's box, the
    Terminal and the background run claude with it. The Terminal gets its command typed in, so a
    control character (a key press there, such as Ctrl-U or Enter) is never let through: the prompt
    may hold line breaks, the folder nothing of the kind. In the background the prompt is an argument
    of its own, which may hold anything but a zero byte."""
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, "That request could not be read."
    if not isinstance(data, dict):
        return None, "That request could not be read."
    folder, where, prompt, app = data.get("folder"), data.get("where"), data.get("prompt", ""), data.get("app")
    mode = data.get("mode", "")
    if where not in START_PLACES:
        return None, "Pick the Claude app, the Terminal or the background."
    if not isinstance(folder, str) or not folder.startswith("/") or len(folder) > 4096 or CONTROL.search(folder) or not os.path.isdir(folder):
        return None, "That folder is not on this Mac."
    if not isinstance(prompt, str) or len(prompt) > START_PROMPT_MAX:
        return None, "The first message is too long for the Terminal. Start with a shorter one and send the rest from the chat."
    if (CONTROL.search(prompt.replace("\n", "")) if where != "background" else "\0" in prompt):
        return None, "The first message holds a character the Terminal would take as a key press. Write it without it."
    if mode not in START_MODES:
        return None, "Pick one of the modes in the list."
    app = terminals.chosen_app(app, terminals.installed_apps())
    # the app's link takes no mode: a session there starts in the app's own default
    return (os.path.realpath(folder), where, prompt.strip(), app, mode if where != "app" else ""), ""

PICK_SCRIPT = """on run argv
  activate
  return POSIX path of (choose folder with prompt "Folder for the new Claude Code session")
end run"""


def start_command(folder: str, where: str, prompt: str, app: str = "terminal", mode: str = "") -> list:
    """The command that starts the session: the Claude app's own link for a new Code session in a
    folder, with the first prompt written in its box (`q`; the app leaves sending it to the person),
    or a window of the person's terminal app (iTerm or Terminal) that goes to the folder and
    runs claude with the first prompt. The folder and the prompt are quoted for the shell there and
    go to the script as an argument, never as part of it, so nothing in them runs."""
    if where == "app":
        link = f"claude://code/new?folder={quote(folder, safe='')}"
        return ["open", link + (f"&q={quote(prompt, safe='')}" if prompt else "")]
    flag = f" --permission-mode {shlex.quote(mode)}" if mode in START_MODES and mode else ""
    command = f"cd {shlex.quote(folder)} && claude{flag}" + (f" -- {shlex.quote(prompt)}" if prompt else "")
    return terminals.app_command(app, command)


def claude_program(environ=os.environ, places=CLAUDE_PLACES):
    """Where claude is on this Mac, or None."""
    found = shutil.which("claude", path=environ.get("PATH"))
    if found:
        return found
    return next((str(place) for place in places if os.access(place, os.X_OK)), None)


def is_trusted(folder: str, config: Path = CLAUDE_CONFIG) -> bool:
    """Whether the person told Claude to trust the folder, as Claude's own settings file says."""
    try:
        projects = json.loads(config.read_text()).get("projects")
    except (OSError, ValueError, AttributeError):
        return False
    entry = projects.get(folder) if isinstance(projects, dict) else None
    return isinstance(entry, dict) and entry.get("hasTrustDialogAccepted") is True


def background_command(program: str, session_id: str, prompt: str, mode: str) -> list:
    """claude with the id CCC picked for the session, so the board knows which card it is, in the
    mode asked for, with the first message. Each part is its own argument: nothing in them runs."""
    return [program, "--session-id", session_id, *(["--permission-mode", mode] if mode else []), *(["--", prompt] if prompt else [])]


def start_background(terms, folder: str, prompt: str, mode: str, program=None, trusted=is_trusted):
    """Starts Claude in the background, in a terminal of CCC's keeper: (what the board needs to find
    it, '') or (None, what went wrong). In a folder Claude was never told to trust, it asks first,
    and only the person can answer: its terminal is on the board from the start. A first message is
    needed: Claude starts its session only with one, and nobody sees its screen to type it."""
    if not prompt.strip():
        return None, "Write the first message: in the background, Claude starts with it."
    program = program or claude_program()
    if not program:
        return None, "Claude Code is not installed where CCC can find it (no claude in your PATH or ~/.local/bin)."
    session_id = str(uuid.uuid4())
    is_hidden = trusted(folder)
    terminal_id, problem = terms.start(folder, *BACKGROUND_SIZE, command=background_command(program, session_id, prompt, mode), session_id=session_id, is_hidden=is_hidden)
    if not terminal_id:
        return None, problem
    return {"sessionId": session_id, "terminalId": terminal_id, "shown": not is_hidden}, ""


class Backgrounds:
    """The sessions CCC started in the background: their folder and mode, so one that stopped
    without the person ending it (the Mac restarted) can be resumed. Ending one forgets it."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()

    def load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        kept = data.get("sessions") if isinstance(data, dict) else None
        return {key: value for key, value in kept.items() if SAFE_ID.match(key) and isinstance(value, dict)} if isinstance(kept, dict) else {}

    def save(self, kept: dict):
        newest = dict(sorted(kept.items(), key=lambda item: item[1].get("at") or 0, reverse=True)[:BACKGROUND_KEPT])
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"sessions": newest}), encoding="utf-8")
        temporary.replace(self.path)

    def keep(self, session_id: str, folder: str, mode: str, now_ms: int):
        with self.lock:
            kept = self.load()
            kept[session_id] = {"folder": folder, "mode": mode if mode in START_MODES else "", "at": now_ms}
            self.save(kept)

    def get(self, session_id: str):
        return self.load().get(session_id) if isinstance(session_id, str) else None

    def forget(self, session_id: str):
        with self.lock:
            kept = self.load()
            if kept.pop(session_id, None) is not None:
                self.save(kept)


def runs_now(snapshot_path: Path, now_ms: int) -> bool:
    """Whether a session's snapshot says it runs somewhere now: written lately, and not ended."""
    try:
        data = json.loads(snapshot_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(data, dict) and data.get("endedAt") is None and isinstance(data.get("updatedAt"), int) and now_ms - data["updatedAt"] < RUNS_NOW_MS


def stopped_backgrounds(backgrounds, cards: list, sessions_dir: Path, transcripts, now_ms: int) -> list:
    """The background sessions that stopped without the person ending them, newest first: not in
    the keeper, not running anywhere else, and with a conversation in Claude's history to resume."""
    in_keeper = {card.get("sessionId") for card in cards if isinstance(card, dict) and not card.get("endedAt")}
    stopped = []
    for session_id, kept in sorted(backgrounds.load().items(), key=lambda item: item[1].get("at") or 0, reverse=True):
        if session_id in in_keeper or runs_now(sessions_dir / f"{session_id}.json", now_ms):
            continue
        path = transcripts.find(session_id)
        if path is None:
            continue
        folder = folder_of(path) or kept.get("folder") or ""
        title = transcripts.describe(session_id).get("title") or first_prompt(path) or Path(folder).name or folder
        stopped.append({"sessionId": session_id, "title": title, "folder": folder, "at": kept.get("at")})
    return stopped


def prompt_for(message: dict) -> str:
    """A message from the inbox as it goes in, as the session's mod writes it (hooks/inbox.ts): its
    words, then where its files and images are, so Claude opens them."""
    listed = lambda paths: "\n".join(f"- {path}" for path in paths)
    files = [path for path in message.get("files") or [] if isinstance(path, str)]
    images = [path for path in message.get("images") or [] if isinstance(path, str)]
    parts = [
        str(message.get("text") or "").strip(),
        f"Files I added (open them with the Read tool):\n{listed(files)}" if files else "",
        f"Images I added (open them with the Read tool):\n{listed(images)}" if images else "",
    ]
    return "\n\n".join(part for part in parts if part)


def resume_background(terms, backgrounds, inbox, transcripts, session_id: str, text: str, program=None, trusted=is_trusted):
    """Picks a stopped background session up again, in the background: (what the board needs, '') or
    (None, what went wrong). Claude starts only with a message, so it goes in with one: the oldest
    written to it that never went in, else the person's `text`, else RESUME_PROMPT."""
    kept = backgrounds.get(session_id)
    if not kept:
        return None, "CCC did not start that session in the background."
    path = transcripts.find(session_id)
    folder = folder_of(path) if path else None
    if not folder or not os.path.isdir(folder):
        return None, "That conversation's folder is not on this Mac any more."
    if any(isinstance(card, dict) and card.get("sessionId") == session_id and not card.get("endedAt") for card in terms.list()):
        return None, "It runs in the background already."
    program = program or claude_program()
    if not program:
        return None, "Claude Code is not installed where CCC can find it (no claude in your PATH or ~/.local/bin)."
    waiting = inbox.take_first(session_id)
    prompt = prompt_for(waiting) if waiting else (text.strip() if isinstance(text, str) and text.strip() else RESUME_PROMPT)
    mode = kept.get("mode") if kept.get("mode") in START_MODES else ""
    command = [program, "--resume", session_id, *(["--permission-mode", mode] if mode else []), "--", prompt]
    folder = os.path.realpath(folder)
    is_hidden = trusted(folder)
    terminal_id, problem = terms.start(folder, *BACKGROUND_SIZE, command=command, session_id=session_id, is_hidden=is_hidden)
    if not terminal_id:
        return None, problem
    return {"sessionId": session_id, "terminalId": terminal_id, "shown": not is_hidden}, ""


def reveal_waiting(terms, cards: list, sessions_dir: Path, now_ms: int) -> list:
    """The terminals, with each background session that never came onto the board put there, as it
    waits for something only its own screen shows (a question Claude asks before it starts)."""
    shown = []
    for card in cards:
        session_id = card.get("sessionId") if isinstance(card, dict) else None
        is_waiting = (
            card.get("hidden") is True
            and not card.get("endedAt")
            and isinstance(session_id, str)
            and SAFE_ID.match(session_id)
            and isinstance(card.get("startedAt"), int)
            and now_ms - card["startedAt"] >= BACKGROUND_WAIT_MS
            and not (sessions_dir / f"{session_id}.json").exists()
        )
        if is_waiting and terms.show(card["id"], False):
            card = {**card, "hidden": False}
        shown.append(card)
    return shown


def named_backgrounds(cards: list, transcripts, removed: dict) -> list:
    """The terminals, each Claude in the background with its conversation's name, and whether the
    person closed its card from CCC (it runs on, and Settings lists it to show it again)."""
    named = []
    for card in cards:
        session_id = card.get("sessionId") if isinstance(card, dict) else None
        if isinstance(session_id, str) and SAFE_ID.match(session_id):
            path = transcripts.find(session_id)
            title = (transcripts.describe(session_id).get("title") or first_prompt(path)) if path else ""
            card = {**card, **({"title": title[:200]} if title else {}), "closed": session_id in removed}
        named.append(card)
    return named


def end_background(terms, session_id: str):
    """Ends the background Claude a session runs in, if it runs in one, and lets its terminal go."""
    for card in terms.list():
        if isinstance(card, dict) and card.get("sessionId") == session_id:
            terms.close(card.get("id"))


def end_session(inbox, session_id: str, now_ms: int):
    """Ends a conversation's context: Claude stops, then /clear runs in the session, so it starts
    over empty. The conversation stays in Claude's history; the session's mod takes both in order."""
    inbox.stop(session_id, now_ms)
    inbox.send(session_id, "/clear", [], "queue", now_ms + 1)


def resume_command(folder: str, session_id: str, app: str = "terminal") -> list:
    """A window of the terminal app that goes to the conversation's folder and picks it up again."""
    return terminals.app_command(app, f"cd {shlex.quote(folder)} && claude --resume {shlex.quote(session_id)}")


def start_session(folder: str, where: str, prompt: str, app: str = "terminal", mode: str = "", run=subprocess.run) -> str:
    """Starts it; what went wrong, or '' when it is on its way."""
    try:
        done = run(start_command(folder, where, prompt, app, mode), capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return "Could not start it."
    return "" if done.returncode == 0 else "Could not start it. " + (done.stderr or "").strip()[:200]


PICKING = threading.Lock()


def pick_folder(run=subprocess.run):
    """The folder the person picks in the Mac's own folder dialog: ('/the/folder', ''), or (None,
    'cancelled'), or (None, 'busy') while a dialog is already open, so only one is ever up."""
    if not PICKING.acquire(blocking=False):
        return None, "busy"
    try:
        done = run(["osascript", "-e", PICK_SCRIPT], capture_output=True, text=True, timeout=PICK_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError):
        return None, "cancelled"
    finally:
        PICKING.release()
    folder = (done.stdout.strip().rstrip("/") or "/") if done.returncode == 0 and done.stdout.strip() else ""
    return (folder, "") if folder.startswith("/") and os.path.isdir(folder) else (None, "cancelled")


def clean_notes(raw) -> str:
    """The notes as stored: one plain text, cut to MAX_NOTES_TEXT characters."""
    text = raw.get("text") if isinstance(raw, dict) else None
    return text[:MAX_NOTES_TEXT] if isinstance(text, str) else ""


class Notes:
    """The person's notes, one free text kept in a small file beside the sessions."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()

    def load(self) -> str:
        try:
            return clean_notes(json.loads(self.path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return ""

    def save(self, text: str):
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(json.dumps({"text": text}), encoding="utf-8")
            temporary.replace(self.path)


TRANSCRIPTS = Transcripts(PROJECTS_DIR)
FILE_LISTS = mentions.FileLists()
APP_SESSIONS = AppSessions(APP_SESSIONS_DIR)
TOKENS = UsageLedger(PROJECTS_DIR)
INBOX = Inbox(INBOX_DIR, UPLOADS_DIR)
ANSWERS = Answers(ANSWERS_DIR, TRANSCRIPTS)
APPROVALS = Approvals(APPROVALS_DIR)
REMOVALS = Removals(REMOVED_FILE)
PINS = Pins(PINNED_FILE)
CAVEMAN = Caveman(CAVEMAN_DIR)
NOTES = Notes(NOTES_FILE)
TERMINALS = keeper.KeptTerminals()
BACKGROUNDS = Backgrounds(BACKGROUND_FILE)


def with_transcript_facts(sessions: list, transcripts: Transcripts) -> list:
    """Each snapshot with the name the Claude app shows for it and its permission mode, when known,
    and its runs settled where the transcript reports them ended."""
    merged = []
    for session in sessions:
        facts = dict(transcripts.describe(session.get("sessionId")))
        ended = facts.pop("endedTasks", None)
        session = {**session, **facts}
        if ended and isinstance(session.get("runs"), list):
            session["runs"] = settle_runs(session["runs"], ended)
        merged.append(session)
    return merged


def with_shown_approvals(sessions: list, prompts_dir: Path) -> list:
    """Each snapshot whose approval box is in front of the person marked so. Claude Code tells a
    settings hook when a box waits (prompt_seen.py leaves the time); a notice from before the
    approval began is about an earlier box."""
    marked = []
    for session in sessions:
        turn = session.get("turn")
        waiting = turn.get("waiting") if isinstance(turn, dict) else None
        if isinstance(waiting, dict) and waiting.get("kind") == "approval":
            seen = prompt_seen_at(prompts_dir, session.get("sessionId"))
            since = waiting.get("since")
            if seen is not None and isinstance(since, (int, float)) and seen >= since:
                session = {**session, "turn": {**turn, "waiting": {**waiting, "isShown": True}}}
        marked.append(session)
    return marked


def prompt_seen_at(prompts_dir: Path, session_id):
    """When Claude Code last said an approval box of the session waits, or None."""
    if not isinstance(session_id, str) or not SAFE_ID.match(session_id):
        return None
    try:
        at = json.loads((prompts_dir / f"{session_id}.json").read_text()).get("at")
    except (OSError, ValueError, AttributeError):
        return None
    return at if isinstance(at, (int, float)) and not isinstance(at, bool) else None


def with_app_ids(sessions: list, app_ids: dict) -> list:
    """Each snapshot with the Claude app's own id for it, when the app holds the session."""
    return [{**session, "appSessionId": app_ids[session.get("sessionId")]} if session.get("sessionId") in app_ids else session for session in sessions]


def board_payload(sessions_dir: Path, removals: Removals, transcripts: Transcripts, app_sessions=None, prompts_dir: Path = PROMPTS_DIR, approvals_dir: Path = APPROVALS_DIR, pins=None) -> dict:
    sessions = with_shown_approvals(with_transcript_facts(read_sessions(sessions_dir), transcripts), prompts_dir)
    sessions = with_approval_boxes(sessions, approvals_dir, time.time() * 1000)
    shown, hidden, back = split_removed(sessions, removals.load())
    removals.forget(back)
    sessions = with_added(shown, hidden, pins.load(), transcripts) if pins is not None else shown
    if app_sessions is not None:
        sessions = with_app_ids(sessions, app_sessions.ids())
    return {"sessions": sessions, "hidden": hidden, "boardVersion": board_version()}


def history_days(path: str) -> int:
    """How many days of token history a request asks for: 1 to 90, 7 when it does not say."""
    asked = parse_qs(urlsplit(path).query).get("days", ["7"])[0]
    return max(1, min(TOKEN_HISTORY_DAYS, int(asked))) if asked.isdigit() else 7


def is_local_host(host_header: str, port: int) -> bool:
    """Only the board's own address; refuses other names pointed at 127.0.0.1."""
    return host_header in {f"127.0.0.1:{port}", f"localhost:{port}"}


def is_from_board(headers, port: int, action: str = "remove") -> bool:
    """A change comes only from the board's own page: its custom header (which other sites
    cannot send without a preflight this server never grants) and, when given, its own origin."""
    origin = headers.get("Origin")
    allowed = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
    return headers.get(ACTION_HEADER) == action and (origin is None or origin in allowed)


def removal_target(body: bytes):
    """The session id a removal names, or None when the body is not a plain, valid request."""
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    session_id = data.get("sessionId") if isinstance(data, dict) else None
    return session_id if isinstance(session_id, str) and SAFE_ID.match(session_id) else None


TERMINAL_ROUTES = {"/api/terminal/start": "terminal-start", "/api/terminal/type": "terminal-type", "/api/terminal/resize": "terminal-resize", "/api/terminal/close": "terminal-close", "/api/terminal/open": "terminal-open", "/api/terminal/show": "terminal-show", "/api/keeper/stop": "terminal-keeper-stop"}
TERMINAL_KEY_HEADER = "X-CCC-Key"
MAX_TERMINAL_BODY_BYTES = 256 * 1024


def has_terminal_key(headers, key: str) -> bool:
    """A terminal is reached only with the key this server made when it started, which only the
    board's own page can read; a website or another program that guesses the address has none."""
    given = headers.get(TERMINAL_KEY_HEADER) or ""
    return bool(given) and secrets.compare_digest(given, key)


def json_object(body: bytes):
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def terminal_action(terms, action: str, data: dict, run=subprocess.run, close_session=lambda session_id: None) -> dict:
    """Does what the board asks of a terminal, and says how it went. `close_session` takes a
    session off the board, as its card's × does."""
    if action == "terminal-start":
        folder = data.get("folder")
        if not isinstance(folder, str) or len(folder) > 4096 or CONTROL.search(folder):
            return {"ok": False, "problem": "That folder is not on this Mac."}
        cols, rows = data.get("cols"), data.get("rows")
        size = (cols, rows) if isinstance(cols, int) and isinstance(rows, int) else (80, 24)
        terminal_id, problem = terms.start(folder, *size)
        return {"ok": True, "id": terminal_id} if terminal_id else {"ok": False, "problem": problem}
    if action == "terminal-type":
        return {"ok": terms.type(data.get("id"), data.get("data"))}
    if action == "terminal-resize":
        return {"ok": terms.resize(data.get("id"), data.get("cols"), data.get("rows"))}
    if action == "terminal-close":
        return {"ok": terms.close(data.get("id"))}
    if action == "terminal-show":
        return {"ok": terms.show(data.get("id"), data.get("hidden"))}
    if action == "terminal-keeper-stop":
        # the background sessions go with the keeper: their cards close, as "End it" closes one
        sessions = {card.get("sessionId") for card in terms.list() if isinstance(card, dict) and isinstance(card.get("sessionId"), str) and SAFE_ID.match(card["sessionId"])}
        ended = terms.stop_keeper()
        for session_id in sorted(sessions):
            close_session(session_id)
        return {"ok": True, "ended": ended}
    folder = terms.folder_now(data.get("id"))
    if folder is None:
        return {"ok": False, "problem": "That terminal is gone."}
    app = terminals.chosen_app(data.get("app"), terminals.installed_apps())
    try:
        done = run(terminals.app_command(app, f"cd {shlex.quote(folder)}"), capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return {"ok": False, "problem": "Could not open the terminal app."}
    if done.returncode != 0:
        return {"ok": False, "problem": "Could not open the terminal app. " + (done.stderr or "").strip()[:200]}
    return {"ok": True}


def close_on_board(session_id: str):
    """Takes a background session off the board, as "End it" does: ended by the person, it is
    no longer one to resume."""
    REMOVALS.remove(session_id, int(time.time() * 1000))
    PINS.drop(session_id)
    BACKGROUNDS.forget(session_id)


def open_step_file(transcripts, data: dict, open_file=editors.open_file, installed=editors.installed_editors) -> dict:
    """Opens the file a step in a session touched, in the editor asked for (or the one running), at
    the step's line. The file comes from the session's transcript, never from the page."""
    session_id, tool_id = data.get("sessionId"), data.get("toolId")
    if not isinstance(session_id, str) or not SAFE_ID.match(session_id) or not isinstance(tool_id, str) or not TOOL_ID.match(tool_id):
        return {"ok": False, "problem": "That step could not be found."}
    path = transcripts.find(session_id)
    step = read_step(path, tool_id) if path else None
    if not step or not step.get("filePath"):
        return {"ok": False, "problem": "That step did not touch a file."}
    editor = editors.chosen_editor(data.get("editor"), installed())
    if editor is None:
        return {"ok": False, "problem": "No editor CCC knows is installed: IntelliJ IDEA or VS Code."}
    problem = open_file(editor, step["filePath"], step.get("fileLine", 1))
    return {"ok": not problem, "editor": editor["name"], **({"problem": problem} if problem else {})}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BOARD_DIR), **kwargs)

    def do_GET(self):
        if not is_local_host(self.headers.get("Host", ""), PORT):
            return self.send_error(403)
        route = self.path.split("?", 1)[0]
        if route == "/api/health":
            return self.send_json({"app": "ccc", "ok": True})
        if route == "/api/sessions":
            payload = board_payload(SESSIONS_DIR, REMOVALS, TRANSCRIPTS, APP_SESSIONS, pins=PINS)
            editor_apps = [{"id": editor["id"], "name": editor["name"]} for editor in editors.installed_editors()]
            now_ms = int(time.time() * 1000)
            cards = named_backgrounds(reveal_waiting(TERMINALS, TERMINALS.list(), SESSIONS_DIR, now_ms), TRANSCRIPTS, REMOVALS.load())
            stopped = stopped_backgrounds(BACKGROUNDS, cards, SESSIONS_DIR, TRANSCRIPTS, now_ms)
            return self.send_json({**payload, "terminals": cards, "stopped": stopped, "keeper": {"running": TERMINALS.is_running, "outdated": TERMINALS.is_outdated}, "terminalApps": terminals.installed_apps(), "editorApps": editor_apps, "caveman": CAVEMAN.choices()})
        if route == "/api/terminals/key":
            # only the board's own page may learn the key: the browser marks a request from any other site
            if self.headers.get("Sec-Fetch-Site") != "same-origin":
                return self.send_error(403)
            return self.send_json({"key": TERMINALS.key})
        if route == "/api/terminals/stream":
            if not has_terminal_key(self.headers, TERMINALS.key):
                return self.send_error(403)
            return self.send_stream(TERMINALS.frames())
        if route == "/api/existing":
            shown = board_payload(SESSIONS_DIR, REMOVALS, TRANSCRIPTS, APP_SESSIONS, pins=PINS)["sessions"]
            on_board = {session.get("sessionId") for session in shown}
            return self.send_json({"conversations": existing_conversations(PROJECTS_DIR, TRANSCRIPTS, APP_SESSIONS.ids(), on_board)})
        if route == "/api/tokens":
            return self.send_json(TOKENS.summary(time.time()))
        if route == "/api/folders":
            return self.send_json({"folders": recent_folders(PROJECTS_DIR)})
        if route == "/api/tokens/history":
            return self.send_json(TOKENS.history(time.time(), history_days(self.path)))
        if route == "/api/notes":
            return self.send_json({"text": NOTES.load()})
        if route == "/api/commands":
            session_id = parse_qs(urlsplit(self.path).query).get("session", [""])[0]
            return self.send_json(read_commands(COMMANDS_DIR, session_id))
        if route == "/api/files":
            query = parse_qs(urlsplit(self.path).query)
            return self.send_json(session_files(query.get("session", [""])[0], query.get("q", [""])[0], TRANSCRIPTS, FILE_LISTS))
        if route == "/api/chat":
            session_id = parse_qs(urlsplit(self.path).query).get("session", [""])[0]
            return self.send_json(chat_payload(session_id, TRANSCRIPTS, INBOX))
        if route == "/api/step":
            query = parse_qs(urlsplit(self.path).query)
            session_id, tool_id = query.get("session", [""])[0], query.get("tool", [""])[0]
            path = TRANSCRIPTS.find(session_id) if SAFE_ID.match(session_id) else None
            step = read_step(path, tool_id) if path else None
            if step is None:
                return self.send_error(404)
            return self.send_json(step)
        if route == "/api/picture":
            query = parse_qs(urlsplit(self.path).query)
            session_id, ref = query.get("session", [""])[0], query.get("ref", [""])[0]
            picture = None
            if ref.startswith("upload:"):
                picture = read_upload(UPLOADS_DIR, session_id, ref[len("upload:"):])
            elif SAFE_ID.match(session_id):
                path = TRANSCRIPTS.find(session_id)
                picture = read_picture(path, ref) if path else None
            if picture is None:
                return self.send_error(404)
            return self.send_picture(*picture)
        if route not in BOARD_FILES:
            return self.send_error(404)
        self.path = "/" + BOARD_FILES[route]
        return super().do_GET()

    def do_POST(self):
        route = self.path.split("?", 1)[0]
        action = {"/api/remove": "remove", "/api/notes": "notes", "/api/send": "send", "/api/answer": "answer", "/api/approve": "approve", "/api/start": "start", "/api/pick-folder": "pick", "/api/interrupt": "interrupt", "/api/add": "add", "/api/end": "end", "/api/hurry": "hurry", "/api/open-file": "open-file", "/api/caveman": "caveman", "/api/background/resume": "background-resume", "/api/background/forget": "background-forget", "/api/stop-run": "stop-run", **TERMINAL_ROUTES}.get(route)
        if not is_local_host(self.headers.get("Host", ""), PORT) or action is None or not is_from_board(self.headers, PORT, action):
            return self.send_error(403 if action else 404)
        limits = {"remove": MAX_BODY_BYTES, "notes": MAX_NOTES_BODY_BYTES, "send": MAX_SEND_BODY_BYTES, "answer": MAX_ANSWER_BODY_BYTES, "approve": MAX_BODY_BYTES, "start": MAX_START_BODY_BYTES, "pick": MAX_BODY_BYTES, "interrupt": MAX_BODY_BYTES, "add": MAX_BODY_BYTES, "end": MAX_BODY_BYTES, "hurry": MAX_BODY_BYTES, "open-file": MAX_BODY_BYTES, "caveman": MAX_BODY_BYTES, "background-resume": MAX_START_BODY_BYTES, "background-forget": MAX_BODY_BYTES, "stop-run": MAX_BODY_BYTES}
        if action.startswith("terminal-"):
            if not has_terminal_key(self.headers, TERMINALS.key):
                return self.send_error(403)
            body = self.read_body(MAX_TERMINAL_BODY_BYTES)
            data = json_object(body) if body is not None else None
            if data is None:
                return self.send_error(400)
            return self.send_json(terminal_action(TERMINALS, action, data, close_session=close_on_board))
        body = self.read_body(limits[action])
        if body is None:
            return self.send_error(400)
        if action == "interrupt":
            session_id = removal_target(body)
            if session_id is None:
                return self.send_error(400)
            INBOX.stop(session_id, int(time.time() * 1000))
            return self.send_json({"ok": True})
        if action == "stop-run":
            data = json_object(body) or {}
            session_id, run_id = data.get("sessionId"), data.get("runId")
            if not isinstance(session_id, str) or not SAFE_ID.match(session_id) or not isinstance(run_id, str) or not SAFE_ID.match(run_id):
                return self.send_error(400)
            INBOX.stop_run(session_id, run_id, int(time.time() * 1000))
            return self.send_json({"ok": True})
        if action == "pick":
            folder, why = pick_folder()
            return self.send_json({"folder": folder} if folder else {why: True})
        if action == "start" and b'"resume"' in body:
            request = read_resume_request(body, TRANSCRIPTS)
            if request is None:
                return self.send_json({"ok": False, "problem": "That conversation's folder is not on this Mac any more."})
            app = terminals.chosen_app((json_object(body) or {}).get("app"), terminals.installed_apps())
            try:
                done = subprocess.run(resume_command(*request, app), capture_output=True, text=True, timeout=30)
            except (OSError, subprocess.SubprocessError):
                return self.send_json({"ok": False, "problem": "Could not open the Terminal."})
            problem = "" if done.returncode == 0 else "Could not open the Terminal. " + (done.stderr or "").strip()[:200]
            return self.send_json({"ok": not problem, **({"problem": problem} if problem else {})})
        if action == "start":
            request, problem = read_start_request(body)
            if request is None:
                return self.send_json({"ok": False, "problem": problem})
            folder, where, prompt, _app, mode = request
            if where == "background":
                started, problem = start_background(TERMINALS, folder, prompt, mode)
                if started:
                    BACKGROUNDS.keep(started["sessionId"], folder, mode, int(time.time() * 1000))
                return self.send_json({"ok": True, **started} if started else {"ok": False, "problem": problem})
            problem = start_session(*request)
            return self.send_json({"ok": not problem, **({"problem": problem} if problem else {})})
        if action == "answer":
            request = read_answer_request(body)
            if request is None:
                return self.send_error(400)
            problem = ANSWERS.give(*request, int(time.time() * 1000))
            return self.send_json({"ok": not problem, **({"problem": problem} if problem else {})})
        if action == "approve":
            request = read_approve_request(body)
            if request is None:
                return self.send_error(400)
            session_id, box_id, chosen, branch, said = request
            problem = APPROVALS.give(session_id, box_id, chosen, int(time.time() * 1000), branch, said)
            return self.send_json({"ok": not problem, **({"problem": problem} if problem else {})})
        if action == "send":
            request, problem = read_send_request(body)
            if request is None:
                return self.send_json({"ok": False, "problem": problem})
            session_id, text, images, mode, files = request
            message_id = INBOX.send(session_id, text, images, mode, int(time.time() * 1000), files)
            return self.send_json({"ok": True, "id": message_id})
        if action == "remove":
            session_id = removal_target(body)
            if session_id is None:
                return self.send_error(400)
            REMOVALS.remove(session_id, int(time.time() * 1000))
            PINS.drop(session_id)
            # a session run in the background goes on there unless the person ends it ("End it")
            if (json_object(body) or {}).get("end") is True:
                end_background(TERMINALS, session_id)
                BACKGROUNDS.forget(session_id)
            return self.send_json({"ok": True})
        if action in ("background-resume", "background-forget"):
            data = json_object(body) or {}
            session_id = data.get("sessionId")
            if not isinstance(session_id, str) or not SAFE_ID.match(session_id):
                return self.send_error(400)
            if action == "background-forget":
                BACKGROUNDS.forget(session_id)
                return self.send_json({"ok": True})
            text = data.get("text") if isinstance(data.get("text"), str) else ""
            started, problem = resume_background(TERMINALS, BACKGROUNDS, INBOX, TRANSCRIPTS, session_id, text[:START_PROMPT_MAX])
            if started:
                # it comes back onto the board, as one added from the history does
                REMOVALS.forget([session_id])
                kept = BACKGROUNDS.get(session_id) or {}
                BACKGROUNDS.keep(session_id, kept.get("folder", ""), kept.get("mode", ""), int(time.time() * 1000))
            return self.send_json({"ok": True, **started} if started else {"ok": False, "problem": problem})
        if action == "add":
            session_id = removal_target(body)
            if session_id is None or TRANSCRIPTS.find(session_id) is None:
                return self.send_json({"ok": False, "problem": "That conversation is not in Claude's history on this Mac."})
            REMOVALS.forget([session_id])
            PINS.add(session_id, int(time.time() * 1000))
            return self.send_json({"ok": True})
        if action == "hurry":
            try:
                data = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                return self.send_error(400)
            if not isinstance(data, dict):
                return self.send_error(400)
            is_hurried = INBOX.hurry(str(data.get("sessionId", "")), str(data.get("id", "")), int(time.time() * 1000))
            return self.send_json({"ok": is_hurried, **({} if is_hurried else {"problem": "It has gone in already."})})
        if action == "open-file":
            return self.send_json(open_step_file(TRANSCRIPTS, json_object(body) or {}))
        if action == "caveman":
            request = read_caveman_request(body)
            if request is None:
                return self.send_error(400)
            CAVEMAN.choose(*request)
            return self.send_json({"ok": True, "caveman": CAVEMAN.choices()})
        if action == "end":
            session_id = removal_target(body)
            if session_id is None:
                return self.send_error(400)
            now_ms = int(time.time() * 1000)
            end_session(INBOX, session_id, now_ms)
            REMOVALS.remove(session_id, now_ms)
            PINS.drop(session_id)
            return self.send_json({"ok": True})
        try:
            text = clean_notes(json.loads(body.decode("utf-8")))
        except (UnicodeDecodeError, ValueError):
            return self.send_error(400)
        NOTES.save(text)
        return self.send_json({"ok": True})

    def read_body(self, limit: int):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0 or length > limit:
            return None
        return self.rfile.read(length)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_picture(self, media_type: str, content: bytes):
        self.send_response(200)
        self.send_header("Content-Type", media_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def send_stream(self, frames):
        """A response that stays open and sends each frame as it comes, until the page goes away."""
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            for piece in frames:
                self.wfile.write(piece)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            # a stream from the keeper lets go of its connection to it now, not whenever it is collected
            getattr(frames, "close", lambda: None)()
        self.close_connection = True

    def send_json(self, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(f"ccc: board at http://{HOST}:{PORT}/", flush=True)
    # the terminals live in the keeper, so they go on when this server stops
    server.serve_forever()


if __name__ == "__main__":
    main()
