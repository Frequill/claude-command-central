"""Terminals on the board: a real shell per card, on this Mac only.

Each terminal is the person's own login shell in a pseudo-terminal, so colours, Tab, vim and Ctrl+C
work as they do in iTerm. The board reads what the shells print through one long request (so many
terminals never use up the browser's few connections) and sends key presses with small POSTs.

The terminals live in CCC's keeper (keeper.py), a small program of its own, so they keep running
when the board's server stops. A terminal can also run Claude in the background instead of a
shell: hidden from the board until the person asks to see it.

What differs between systems is kept in the functions at the bottom (spawn_shell, set_size,
hang_up, folder_of): a Windows version would swap those for its own terminals (ConPTY).
"""

import base64
import fcntl
import json
import os
import pty
import re
import secrets
import signal
import struct
import subprocess
import termios
import threading
import time
import warnings
from pathlib import Path

# the child of pty.fork only becomes the shell, which is safe with the server's other threads
warnings.filterwarnings("ignore", message=".*fork.*", category=DeprecationWarning)

MAX_TERMINALS = 24
# what a card shows again after the board reloads: the last stretch of what its shell printed
KEEP_BYTES = 512 * 1024
READ_BYTES = 64 * 1024
MAX_INPUT = 64 * 1024
TERMINAL_ID = re.compile(r"^t[0-9a-f]{12}$")
# how long the stream waits for output before it sends a heartbeat, so a dead page is noticed
BEAT_S = 15
ENDED_KEPT_S = 24 * 3600
# while a shell prints, how often its folder is looked up again, so the card's header follows a cd
WHERE_EVERY_S = 2
COLS = (2, 1000)
ROWS = (1, 500)
# what Claude asks before it starts in a folder nobody said to trust yet; letters only, as the
# screen puts cursor moves between its words
TRUST_QUESTION = b"Itrustthisfolder"
TRUST_LOOK_BYTES = 256 * 1024
ESCAPES = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]|\s")
# what a Claude session puts in the surroundings of what it runs: a shell or a Claude started from
# here is not part of that session, so these never reach them (a claude that sees them would think
# it is that session's helper and keep no transcript)
SESSION_VARS = re.compile(r"^(CCC_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_|MCP_|ENABLE_BETA_TRACING)")


def clamp(value, low_high):
    low, high = low_high
    return max(low, min(high, int(value)))


def shell_of(environ) -> str:
    """The person's own shell, as their account says; zsh when it says nothing usable."""
    shell = environ.get("SHELL", "")
    return shell if shell.startswith("/") and os.access(shell, os.X_OK) else "/bin/zsh"


def shell_env(environ) -> dict:
    """The shell's surroundings: the server's own, without what a Claude session put there, told it is
    a colour terminal that reads UTF-8."""
    env = {key: value for key, value in environ.items() if not SESSION_VARS.match(key)}
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env["TERM_PROGRAM"] = "CCC"
    if "UTF-8" not in env.get("LANG", "").upper():
        env["LANG"] = "en_US.UTF-8"
    return env


class Terminal:
    """One shell, or one Claude run in the background, and what it has printed lately. `seq` counts
    every byte it ever printed. A hidden one is left off the board until the person shows it."""

    def __init__(self, terminal_id: str, folder: str, pid: int, fd: int, now_ms: int, session_id=None, is_hidden=False):
        self.id = terminal_id
        self.folder = folder
        self.pid = pid
        self.fd = fd
        self.started_at = now_ms
        self.ended_at = None
        self.exit_code = None
        self.kept = bytearray()
        self.seq = 0
        # the folder the shell is in now, and when it was last looked up
        self.where = folder
        self.where_seq = 0
        self.where_at = 0.0
        # the Claude session it runs, when it runs one instead of a shell
        self.session_id = session_id
        self.is_hidden = is_hidden

    def card(self) -> dict:
        claude = {"kind": "claude", "sessionId": self.session_id, "hidden": self.is_hidden} if self.session_id else {}
        return {
            "id": self.id,
            "folder": self.folder,
            "where": self.where,
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "exitCode": self.exit_code,
            **claude,
        }


class Terminals:
    """Every terminal the keeper runs. Shells end when the keeper stops."""

    def __init__(self, environ=None, spawn=None, clock=time.time):
        self.environ = dict(os.environ if environ is None else environ)
        self.spawn = spawn or spawn_shell
        self.clock = clock
        self.key = secrets.token_hex(16)
        self.terminals = {}
        self.changed = threading.Condition()

    def now_ms(self) -> int:
        return int(self.clock() * 1000)

    def list(self) -> list:
        with self.changed:
            self.forget_old()
            now = self.clock()
            # only shells that printed since the last look: a cd ends with a new prompt
            due = [t for t in self.terminals.values() if t.ended_at is None and t.seq != t.where_seq and now - t.where_at >= WHERE_EVERY_S]
            for terminal in due:
                terminal.where_seq, terminal.where_at = terminal.seq, now
        # looked up with the lock let go, so the shells never wait for it
        for terminal in due:
            terminal.where = folder_of(terminal.pid) or terminal.where
        with self.changed:
            return [terminal.card() for terminal in self.terminals.values()]

    def forget_old(self):
        cutoff = self.now_ms() - ENDED_KEPT_S * 1000
        for terminal_id in [t.id for t in self.terminals.values() if t.ended_at and t.ended_at < cutoff]:
            del self.terminals[terminal_id]

    def start(self, folder: str, cols: int = 80, rows: int = 24, command=None, session_id=None, is_hidden=False):
        """(the new terminal's id, '') or (None, what is wrong). With `command` (a program and its
        arguments) the terminal runs that instead of a shell: Claude, for `session_id`."""
        if not folder.startswith("/") or not os.path.isdir(folder):
            return None, "That folder is not on this Mac."
        with self.changed:
            live = [t for t in self.terminals.values() if t.ended_at is None]
            if len(live) >= MAX_TERMINALS:
                return None, f"There are {MAX_TERMINALS} terminals open already. Close one first."
        try:
            pid, fd = self.spawn(shell_of(self.environ), os.path.realpath(folder), shell_env(self.environ), command)
        except OSError as error:
            return None, f"Could not start {'Claude' if command else 'the shell'}. {error.strerror or error}"
        set_size(fd, clamp(cols, COLS), clamp(rows, ROWS))
        terminal = Terminal("t" + secrets.token_hex(6), os.path.realpath(folder), pid, fd, self.now_ms(), session_id, bool(command) and is_hidden)
        with self.changed:
            self.terminals[terminal.id] = terminal
            self.changed.notify_all()
        threading.Thread(target=self.follow, args=(terminal,), daemon=True).start()
        return terminal.id, ""

    def follow(self, terminal: Terminal):
        """Reads the shell until it ends, keeping the newest output for the board."""
        while True:
            try:
                chunk = os.read(terminal.fd, READ_BYTES)
            except OSError:
                chunk = b""
            if not chunk:
                break
            with self.changed:
                terminal.kept += chunk
                if len(terminal.kept) > KEEP_BYTES:
                    del terminal.kept[: len(terminal.kept) - KEEP_BYTES]
                terminal.seq += len(chunk)
                # Claude asks whether to trust the folder, which only the person can answer
                if terminal.is_hidden and terminal.seq <= TRUST_LOOK_BYTES and asks_trust(terminal.kept):
                    terminal.is_hidden = False
                self.changed.notify_all()
        try:
            _, status = os.waitpid(terminal.pid, 0)
            code = os.waitstatus_to_exitcode(status)
        except ChildProcessError:
            code = None
        try:
            os.close(terminal.fd)
        except OSError:
            pass
        with self.changed:
            terminal.ended_at = self.now_ms()
            terminal.exit_code = code
            self.changed.notify_all()

    def get(self, terminal_id):
        return self.terminals.get(terminal_id) if isinstance(terminal_id, str) and TERMINAL_ID.match(terminal_id) else None

    def type(self, terminal_id, text) -> bool:
        terminal = self.get(terminal_id)
        if terminal is None or terminal.ended_at is not None or not isinstance(text, str) or len(text) > MAX_INPUT:
            return False
        data = text.encode("utf-8", "surrogatepass")
        try:
            while data:
                data = data[os.write(terminal.fd, data):]
        except OSError:
            return False
        return True

    def resize(self, terminal_id, cols, rows) -> bool:
        terminal = self.get(terminal_id)
        if terminal is None or terminal.ended_at is not None or not isinstance(cols, int) or not isinstance(rows, int):
            return False
        set_size(terminal.fd, clamp(cols, COLS), clamp(rows, ROWS))
        return True

    def show(self, terminal_id, is_hidden) -> bool:
        """Puts a Claude run in the background on the board, or takes it off again; it keeps running."""
        terminal = self.get(terminal_id)
        if terminal is None or not terminal.session_id or not isinstance(is_hidden, bool):
            return False
        with self.changed:
            terminal.is_hidden = is_hidden
            self.changed.notify_all()
        return True

    def live(self) -> int:
        """How many terminals still run."""
        with self.changed:
            return sum(1 for terminal in self.terminals.values() if terminal.ended_at is None)

    def close(self, terminal_id) -> bool:
        """Ends the shell and everything it runs, then forgets the terminal."""
        terminal = self.get(terminal_id)
        if terminal is None:
            return False
        if terminal.ended_at is None:
            hang_up(terminal.pid)
        with self.changed:
            self.terminals.pop(terminal.id, None)
            self.changed.notify_all()
        return True

    def folder_now(self, terminal_id):
        """The folder the shell is in now (it may have cd'd away), else the one it started in."""
        terminal = self.get(terminal_id)
        if terminal is None:
            return None
        if terminal.ended_at is None:
            where = folder_of(terminal.pid)
            if where:
                terminal.where = where
                return where
        return terminal.folder

    def shown(self) -> dict:
        """The terminals on the board: all but the hidden ones."""
        return {t.id: t for t in self.terminals.values() if not t.is_hidden}

    def frames(self, beat_s: float = BEAT_S, is_open=lambda: True):
        """What the board's stream sends, one JSON line at a time: first every shown terminal's
        kept output in full, then each new piece as it comes, and the end of each shell. A terminal
        that is shown later gets its whole output then, as a new one does."""
        sent = {}
        ended = set()
        with self.changed:
            shown = self.shown()
            first = [{"id": t.id, "reset": True, "data": b64(t.kept)} for t in shown.values()]
            sent.update({t.id: t.seq for t in shown.values()})
        # sent with the lock let go, so a slow page never holds up the shells
        for piece in first:
            yield frame(piece)
        while is_open():
            with self.changed:
                pieces = []
                shown = self.shown()
                for terminal in list(shown.values()):
                    since = sent.get(terminal.id)
                    if since is None:
                        pieces.append({"id": terminal.id, "reset": True, "data": b64(terminal.kept)})
                    elif terminal.seq > since:
                        fresh = min(terminal.seq - since, len(terminal.kept))
                        pieces.append({"id": terminal.id, "data": b64(terminal.kept[-fresh:])})
                    sent[terminal.id] = terminal.seq
                    if terminal.ended_at is not None and terminal.id not in ended:
                        ended.add(terminal.id)
                        pieces.append({"id": terminal.id, "ended": True, "exitCode": terminal.exit_code})
                for gone in [terminal_id for terminal_id in sent if terminal_id not in shown]:
                    del sent[gone]
                    ended.discard(gone)
                if not pieces:
                    self.changed.wait(beat_s)
                    pieces = [] if self.anything_new(sent, ended) else [{"beat": True}]
            for piece in pieces:
                yield frame(piece)

    def anything_new(self, sent, ended) -> bool:
        shown = self.shown()
        return any(
            sent.get(t.id) != t.seq or (t.ended_at is not None and t.id not in ended) for t in shown.values()
        ) or any(terminal_id not in shown for terminal_id in sent)

    def stop_all(self):
        for terminal in list(self.terminals.values()):
            if terminal.ended_at is None:
                hang_up(terminal.pid)


def asks_trust(kept) -> bool:
    """Whether the screen shows Claude's question about trusting the folder."""
    return TRUST_QUESTION in ESCAPES.sub(b"", bytes(kept[-8192:]))


def folder_of(pid: int):
    """The folder a running process is in, or None when it cannot be told."""
    try:
        done = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return None
    for line in done.stdout.splitlines():
        if line.startswith("n/") and os.path.isdir(line[1:]):
            return line[1:]
    return None


def frame(piece: dict) -> bytes:
    return (json.dumps(piece) + "\n").encode("utf-8")


def b64(data) -> str:
    return base64.b64encode(bytes(data)).decode("ascii")


def set_size(fd: int, cols: int, rows: int):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def hang_up(pid: int):
    """What closing a terminal window does: the shell's whole group gets a hang-up."""
    for send in (lambda: os.killpg(pid, signal.SIGHUP), lambda: os.kill(pid, signal.SIGHUP)):
        try:
            send()
            return
        except OSError:
            continue


# signals the server may ignore (nohup ignores hang-ups, Python a broken pipe), which a shell would
# keep ignoring: the shell gets them back, so closing its card ends it and pipes such as `| head` work
RESET_SIGNALS = ("SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM", "SIGPIPE", "SIGXFSZ", "SIGTSTP", "SIGTTIN", "SIGTTOU")


def spawn_shell(shell: str, folder: str, env: dict, command=None):
    """Starts the login shell in a new pseudo-terminal: (its pid, the terminal's file descriptor).
    The child only resets its signals, changes folder and becomes the shell. With `command`, the
    login shell sets up the person's surroundings (their PATH) and then becomes that program; its
    arguments go to it as they are, never through the shell's reading of a command line."""
    argv = [shell, "-l", "-c", 'exec "$0" "$@"', *command] if command else ["-" + os.path.basename(shell)]
    pid, fd = pty.fork()
    if pid == 0:
        try:
            for signal_name in RESET_SIGNALS:
                signal.signal(getattr(signal, signal_name), signal.SIG_DFL)
            os.chdir(folder)
            os.execve(shell, argv, env)
        finally:
            os._exit(127)
    return pid, fd


def installed_apps(applications=Path("/Applications")) -> list:
    """The terminal apps CCC can open a folder in, as this Mac has them; Apple's Terminal always."""
    apps = [{"id": "terminal", "name": "Terminal"}]
    if (applications / "iTerm.app").is_dir():
        apps.insert(0, {"id": "iterm", "name": "iTerm"})
    return apps


def chosen_app(asked, apps: list) -> str:
    """The app a request names when this Mac has it; for 'auto' (or anything else) the first: iTerm
    when it is installed, else Terminal."""
    ids = [app["id"] for app in apps]
    return asked if asked in ids else ids[0]


# the command goes in as an argument, typed into a fresh shell there, so nothing in it runs as script
APP_SCRIPTS = {
    "terminal": """on run argv
  tell application "Terminal"
    activate
    do script (item 1 of argv)
  end tell
end run""",
    "iterm": """on run argv
  set wasRunning to application "iTerm" is running
  tell application "iTerm"
    activate
    if wasRunning then
      set w to (create window with default profile)
    else
      repeat 30 times
        if (count of windows) > 0 then exit repeat
        delay 0.1
      end repeat
      if (count of windows) = 0 then
        set w to (create window with default profile)
      else
        set w to current window
      end if
    end if
    tell current session of w to write text (item 1 of argv)
  end tell
end run""",
}


def app_command(app: str, command: str) -> list:
    """osascript that opens a new window in the terminal app and types the command there."""
    return ["osascript", "-e", APP_SCRIPTS[app], "--", command]
