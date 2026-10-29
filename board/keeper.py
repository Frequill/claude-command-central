"""CCC's keeper: a small program of its own that runs the terminals on the board.

The board's server starts it when it is not running yet and talks to it from then on. The keeper
keeps running when the server stops, so the shells on the board, and Claude sessions started in the
background, go on through a restart of the server, an update of CCC, or a closed terminal window.
Only a restart of the Mac (or `ccc stop --all`) ends them.

The server reaches it on 127.0.0.1, at the port and with the key the keeper writes to a file only
this user can read. Each request is one line of JSON and gets one line back; a stream request gets
the terminals' output, a line at a time, for as long as it stays open. A port and a file work the
same on every system, so only the terminals themselves (terminals.py) differ on Windows.

    python3 keeper.py serve --file F   runs the keeper (the server starts it this way)
    python3 keeper.py count [--file F] how many terminals still run, 0 when none or no keeper
    python3 keeper.py stop [--file F]  ends the keeper and every terminal it runs
"""

import hashlib
import json
import os
import secrets
import socket
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path

import terminals

HERE = Path(__file__).resolve().parent
KEEPER_FILE = Path(os.environ.get("CCC_KEEPER_FILE", Path.home() / ".claude" / "ccc" / "keeper.json"))
MAX_REQUEST = 512 * 1024
CALL_TIMEOUT_S = 10
START_WAIT_S = 5
# how often a stream with no keeper yet looks for one
WAIT_STEP_S = 0.5
# with nothing left running for this long, the keeper ends itself; the server starts it again when needed
IDLE_S = 15 * 60


def version() -> str:
    """This code's version: a keeper running older code is told apart from the server's own."""
    digest = hashlib.sha256()
    for name in ("keeper.py", "terminals.py"):
        digest.update((HERE / name).read_bytes())
    return digest.hexdigest()[:16]


# ---------- the keeper ----------


class Keeper:
    """Answers the server's requests with what the terminals do."""

    def __init__(self, terms, key: str, code_version: str):
        self.terms = terms
        self.key = key
        self.version = code_version
        self.is_quitting = threading.Event()

    def answer(self, request):
        """What one request gets back: a dict, or for a stream the lines to send."""
        if not isinstance(request, dict) or not isinstance(request.get("key"), str) or not secrets.compare_digest(request["key"], self.key):
            return {"ok": False, "problem": "wrong key"}
        call, args = request.get("call"), request.get("args")
        args = args if isinstance(args, dict) else {}
        terms = self.terms
        if call == "hello":
            return {"ok": True, "version": self.version, "pid": os.getpid(), "live": terms.live()}
        if call == "list":
            return {"ok": True, "terminals": terms.list()}
        if call == "start":
            command = args.get("command")
            if command is not None and not (isinstance(command, list) and command and all(isinstance(part, str) for part in command)):
                return {"ok": False, "problem": "That is no command."}
            cols, rows = args.get("cols"), args.get("rows")
            size = (cols, rows) if isinstance(cols, int) and isinstance(rows, int) else (80, 24)
            session_id = args.get("sessionId") if isinstance(args.get("sessionId"), str) else None
            terminal_id, problem = terms.start(str(args.get("folder", "")), *size, command=command, session_id=session_id, is_hidden=args.get("hidden") is True)
            return {"ok": True, "id": terminal_id} if terminal_id else {"ok": False, "problem": problem}
        if call == "type":
            return {"ok": terms.type(args.get("id"), args.get("data"))}
        if call == "resize":
            return {"ok": terms.resize(args.get("id"), args.get("cols"), args.get("rows"))}
        if call == "show":
            return {"ok": terms.show(args.get("id"), args.get("hidden"))}
        if call == "close":
            return {"ok": terms.close(args.get("id"))}
        if call == "where":
            return {"ok": True, "folder": terms.folder_now(args.get("id"))}
        if call == "stream":
            return terms.frames(is_open=lambda: not self.is_quitting.is_set())
        if call == "quit":
            live = terms.live()
            if live and args.get("force") is not True:
                return {"ok": False, "live": live}
            self.is_quitting.set()
            return {"ok": True, "live": live}
        return {"ok": False, "problem": "unknown call"}


class Requests(socketserver.StreamRequestHandler):
    def handle(self):
        line = self.rfile.readline(MAX_REQUEST)
        try:
            request = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return
        answer = self.server.keeper.answer(request)
        try:
            if isinstance(answer, dict):
                self.wfile.write(terminals.frame(answer))
                return
            for piece in answer:
                self.wfile.write(piece)
                self.wfile.flush()
        except OSError:
            # the server went away; the stream's generator ends with it
            return
        finally:
            if hasattr(answer, "close"):
                answer.close()


class Listener(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def write_private(path: Path, text: str):
    """Writes a file only this user can read, whole or not at all."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(text)
    os.replace(temporary, path)


def serve(path: Path, clock=time.time):
    """Runs the keeper until it is told to quit, or nothing has run in it for IDLE_S."""
    terms = terminals.Terminals()
    keeper = Keeper(terms, secrets.token_hex(24), version())
    listener = Listener(("127.0.0.1", 0), Requests)
    listener.keeper = keeper
    write_private(path, json.dumps({"port": listener.server_address[1], "key": keeper.key, "pid": os.getpid(), "version": keeper.version}))
    threading.Thread(target=listener.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True).start()
    idle_since = clock()
    try:
        while not keeper.is_quitting.wait(1):
            if terms.live():
                idle_since = clock()
            elif clock() - idle_since >= IDLE_S:
                break
    finally:
        keeper.is_quitting.set()
        terms.stop_all()
        listener.shutdown()
        # only this keeper's own file: a newer keeper may have written its own since
        try:
            if json.loads(path.read_text()).get("pid") == os.getpid():
                path.unlink()
        except (OSError, ValueError):
            pass


# ---------- the server's side ----------


def read_info(path: Path):
    try:
        info = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(info, dict) or not isinstance(info.get("port"), int) or not isinstance(info.get("key"), str):
        return None
    return info


def ask(info: dict, call: str, args=None, timeout=CALL_TIMEOUT_S) -> dict:
    """One request to the keeper and its answer; OSError when the keeper cannot be reached."""
    with socket.create_connection(("127.0.0.1", info["port"]), timeout=timeout) as connection:
        connection.sendall(terminals.frame({"key": info["key"], "call": call, "args": args or {}}))
        line = connection.makefile("rb").readline(MAX_REQUEST)
    try:
        answer = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ConnectionError("the keeper gave no answer") from None
    return answer if isinstance(answer, dict) else {}


def detached(command: list, log: Path):
    """Starts a program that outlives this one: in a session of its own, with no terminal, so a
    closed window or a stopped server never reaches it. (On Windows: DETACHED_PROCESS instead.)"""
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "ab") as out:
        return subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out, stderr=out, start_new_session=True, close_fds=True, cwd=str(Path.home()))


class NotRunning(ConnectionError):
    """No keeper runs, and the call does not need one: there are no terminals."""


class KeptTerminals:
    """The terminals as the board's server sees them: each call goes to the keeper. Starting a
    terminal starts the keeper when it is not running; with no keeper there are no terminals, so
    the board's looks start none (and a keeper with nothing left in it can end itself). A keeper
    running older code is replaced while nothing runs in it; while something does, it stays, and
    `is_outdated` says so."""

    def __init__(self, path: Path = KEEPER_FILE, start=None):
        self.path = path
        self.start_keeper = start or (lambda: detached([sys.executable, str(HERE / "keeper.py"), "serve", "--file", str(path)], path.with_name("keeper.log")))
        # the key the board's page shows with each request; the keeper's own key never leaves this server
        self.key = secrets.token_hex(16)
        self.is_outdated = False
        # whether the keeper answered the last call: the board shows it in its settings
        self.is_running = False
        self.lock = threading.Lock()
        self.info = None

    def ensure(self, may_start=True) -> dict:
        """The keeper's address, starting it first when it is not running and `may_start`."""
        with self.lock:
            # the address found last time, until a call finds the keeper gone
            if self.info:
                return self.info
            info = read_info(self.path)
            if info and self.is_up(info):
                hello = ask(info, "hello")
                if hello.get("version") != version() and not hello.get("live"):
                    ask(info, "quit")
                    self.wait_gone(info)
                    info = None
                else:
                    self.is_outdated = hello.get("version") != version()
            elif info:
                info = None
            if info is None and not may_start:
                raise NotRunning("CCC's keeper is not running")
            if info is None:
                self.start_keeper()
                info = self.wait_started()
                self.is_outdated = False
            self.info = info
            return info

    def is_up(self, info: dict) -> bool:
        try:
            return ask(info, "hello", timeout=2).get("ok") is True
        except OSError:
            return False

    def wait_gone(self, info: dict):
        deadline = time.time() + START_WAIT_S
        while time.time() < deadline and self.is_up(info):
            time.sleep(0.05)

    def wait_started(self) -> dict:
        deadline = time.time() + START_WAIT_S
        while time.time() < deadline:
            info = read_info(self.path)
            if info and self.is_up(info):
                return info
            time.sleep(0.05)
        raise ConnectionError("CCC's keeper did not start")

    def call(self, name: str, args=None, may_start=False) -> dict:
        """The keeper's answer. A keeper that went away is looked for again (and started again, for
        a call that may start it) and asked once more, as a request that never got through did nothing."""
        for attempt in range(2):
            try:
                info = self.ensure(may_start)
            except NotRunning:
                self.is_running = False
                return {"ok": False, "problem": "There is no such terminal."}
            except OSError:
                self.is_running = False
                return {"ok": False, "problem": "CCC's keeper did not start. See ~/.claude/ccc/keeper.log."}
            try:
                answer = ask(info, name, args)
                self.is_running = True
                return answer
            except (ConnectionRefusedError, FileNotFoundError):
                self.info = None
            except OSError:
                return {"ok": False, "problem": "CCC's keeper did not answer."}
        return {"ok": False, "problem": "CCC's keeper did not answer."}

    def list(self) -> list:
        cards = self.call("list").get("terminals")
        return cards if isinstance(cards, list) else []

    def start(self, folder: str, cols: int = 80, rows: int = 24, command=None, session_id=None, is_hidden=False):
        args = {"folder": folder, "cols": cols, "rows": rows}
        if command:
            args.update({"command": command, "sessionId": session_id, "hidden": is_hidden})
        answer = self.call("start", args, may_start=True)
        return (answer["id"], "") if answer.get("ok") and isinstance(answer.get("id"), str) else (None, answer.get("problem") or "Could not start the terminal.")

    def type(self, terminal_id, text) -> bool:
        return self.call("type", {"id": terminal_id, "data": text}).get("ok") is True

    def resize(self, terminal_id, cols, rows) -> bool:
        return self.call("resize", {"id": terminal_id, "cols": cols, "rows": rows}).get("ok") is True

    def show(self, terminal_id, is_hidden) -> bool:
        return self.call("show", {"id": terminal_id, "hidden": is_hidden}).get("ok") is True

    def close(self, terminal_id) -> bool:
        return self.call("close", {"id": terminal_id}).get("ok") is True

    def folder_now(self, terminal_id):
        folder = self.call("where", {"id": terminal_id}).get("folder")
        return folder if isinstance(folder, str) else None

    def frames(self):
        """The keeper's stream, passed on line by line. While no keeper runs it waits for one, with a
        beat now and then; it ends when the keeper goes away, and the board's page then asks again."""
        waited = 0.0
        while True:
            try:
                info = self.ensure(may_start=False)
                connection = socket.create_connection(("127.0.0.1", info["port"]), timeout=CALL_TIMEOUT_S)
                break
            except NotRunning:
                pass
            except OSError:
                self.info = None
            time.sleep(WAIT_STEP_S)
            waited += WAIT_STEP_S
            if waited >= terminals.BEAT_S:
                waited = 0.0
                yield terminals.frame({"beat": True})
        try:
            connection.sendall(terminals.frame({"key": info["key"], "call": "stream", "args": {}}))
            # the keeper sends a beat now and then, so a quiet stream is no dead one
            connection.settimeout(terminals.BEAT_S * 3)
            lines = connection.makefile("rb")
            while True:
                line = lines.readline(MAX_REQUEST * 4)
                if not line.endswith(b"\n"):
                    return
                yield line
        except OSError:
            return
        finally:
            connection.close()

    def stop_keeper(self) -> int:
        """Ends the keeper and everything that runs in it, as `ccc stop --all` does; how many still
        ran. The next terminal starts a new keeper, with the code CCC has now."""
        answer = self.call("quit", {"force": True})
        if answer.get("ok"):
            info = self.info
            if info:
                self.wait_gone(info)
        self.info = None
        self.is_running = False
        self.is_outdated = False
        return answer.get("live", 0) if answer.get("ok") else 0

    def stop_all(self):
        """Nothing: the terminals go on in the keeper when the server stops."""


# ---------- the command line ----------


def main(argv: list) -> int:
    command = argv[0] if argv else ""
    path = Path(argv[argv.index("--file") + 1]) if "--file" in argv[:-1] else KEEPER_FILE
    if command == "serve":
        serve(path)
        return 0
    info = read_info(path)
    try:
        hello = ask(info, "hello", timeout=2) if info else {}
    except OSError:
        hello = {}
    if command == "count":
        print(hello.get("live", 0) if hello.get("ok") else 0)
        return 0
    if command == "stop":
        if not hello.get("ok"):
            print("CCC's keeper was not running.")
            return 0
        ask(info, "quit", {"force": True})
        print("CCC's keeper stopped, and every terminal in it.")
        return 0
    print("Usage: keeper.py serve|count|stop [--file F]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
