"""CCC's keeper: the terminals live in it, and the board's server only talks to it."""

import base64
import json
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path

import keeper
import terminals


class RunningKeeper:
    """A keeper on a port of its own, in this process, writing its address where a client looks."""

    def __init__(self, path: Path, folder: str, code_version=None):
        self.terms = terminals.Terminals(environ={"SHELL": "/bin/sh", "PATH": "/usr/bin:/bin", "HOME": folder})
        self.keeper = keeper.Keeper(self.terms, "k" * 48, code_version or keeper.version())
        self.listener = keeper.Listener(("127.0.0.1", 0), keeper.Requests)
        self.listener.keeper = self.keeper
        threading.Thread(target=self.listener.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.info = {"port": self.listener.server_address[1], "key": self.keeper.key, "pid": os.getpid(), "version": self.keeper.version}
        keeper.write_private(path, json.dumps(self.info))
        self.is_stopped = False
        self.lock = threading.Lock()
        # told to quit, it ends as the real one does
        threading.Thread(target=lambda: (self.keeper.is_quitting.wait(), self.stop()), daemon=True).start()

    def stop(self):
        with self.lock:
            if self.is_stopped:
                return
            self.is_stopped = True
        self.keeper.is_quitting.set()
        self.terms.stop_all()
        self.listener.shutdown()
        self.listener.server_close()


class KeeperTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.folder = os.path.realpath(self.dir.name)
        self.path = Path(self.folder) / "keeper.json"
        self.running = []

    def tearDown(self):
        for one in self.running:
            one.stop()
        self.dir.cleanup()

    def keep(self, code_version=None):
        one = RunningKeeper(self.path, self.folder, code_version)
        self.running.append(one)
        return one

    def read_until(self, frames, terminal_id, wanted, seconds=5):
        seen = b""
        deadline = time.time() + seconds
        while time.time() < deadline:
            piece = json.loads(next(frames))
            if piece.get("id") == terminal_id and "data" in piece:
                seen += base64.b64decode(piece["data"])
                if wanted in seen:
                    return seen
        self.fail(f"never saw {wanted!r} in {seen!r}")

    def test_the_address_file_is_for_this_user_alone(self):
        self.keep()
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_a_request_without_the_keepers_key_gets_nothing(self):
        running = self.keep()
        self.assertEqual(keeper.ask({**running.info, "key": "wrong"}, "list"), {"ok": False, "problem": "wrong key"})
        # what a web page could send to the port: no request the keeper reads
        with socket.create_connection(("127.0.0.1", running.info["port"]), timeout=2) as connection:
            connection.sendall(b"POST / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            self.assertEqual(connection.recv(100), b"")

    def test_the_server_works_its_terminals_through_the_keeper(self):
        self.keep()
        kept = keeper.KeptTerminals(self.path, start=lambda: self.fail("a running keeper is not started again"))
        terminal_id, problem = kept.start(self.folder, 90, 30)
        self.assertEqual(problem, "")
        frames = kept.frames()
        # what the shell prints, not the typed line it echoes
        self.assertTrue(kept.type(terminal_id, "stty size; echo ready$((1+1)).\n"))
        self.assertIn(b"30 90", self.read_until(frames, terminal_id, b"ready2."))
        self.assertTrue(kept.resize(terminal_id, 100, 40))
        self.assertEqual(kept.folder_now(terminal_id), self.folder)
        frames.close()
        # a server started again finds the same terminal, and its output from the start
        again = keeper.KeptTerminals(self.path, start=lambda: self.fail("a running keeper is not started again"))
        self.assertEqual([card["id"] for card in again.list()], [terminal_id])
        first = json.loads(next(again.frames()))
        self.assertTrue(first["reset"])
        self.assertIn(b"ready2.", base64.b64decode(first["data"]))
        self.assertTrue(again.close(terminal_id))
        self.assertEqual(again.list(), [])

    def test_a_background_claude_is_started_hidden_and_shown_through_the_keeper(self):
        self.keep()
        kept = keeper.KeptTerminals(self.path)
        terminal_id, _ = kept.start(self.folder, command=["/bin/sh", "-c", "sleep 5"], session_id="s1", is_hidden=True)
        self.assertEqual({key: kept.list()[0][key] for key in ("kind", "sessionId", "hidden")}, {"kind": "claude", "sessionId": "s1", "hidden": True})
        self.assertTrue(kept.show(terminal_id, False))
        self.assertFalse(kept.list()[0]["hidden"])
        self.assertEqual(kept.start(self.folder, command="sleep 5"), (None, "That is no command."))

    def test_a_keeper_that_is_not_running_is_started_for_a_new_terminal_only(self):
        started = []
        kept = keeper.KeptTerminals(self.path, start=lambda: started.append(self.keep()))
        # no keeper, no terminals: the board's looks start none
        self.assertEqual(kept.list(), [])
        self.assertFalse(kept.type("t000000000000", "x"))
        self.assertEqual(started, [])
        terminal_id, _ = kept.start(self.folder)
        self.assertEqual(len(started), 1)
        self.assertEqual([card["id"] for card in kept.list()], [terminal_id])
        # it went away: its terminals with it, and the next new terminal starts a new keeper
        started[0].stop()
        self.running.remove(started[0])
        self.assertEqual(kept.list(), [])
        kept.start(self.folder)
        self.assertEqual(len(started), 2)

    def test_a_stream_waits_for_a_keeper_to_start(self):
        kept = keeper.KeptTerminals(self.path, start=lambda: self.keep())
        frames = kept.frames()
        got = []
        reader = threading.Thread(target=lambda: got.append(json.loads(next(frames))), daemon=True)
        reader.start()
        time.sleep(0.3)
        terminal_id, _ = kept.start(self.folder)
        reader.join(5)
        self.assertEqual((got[0]["id"], got[0]["reset"]), (terminal_id, True))

    def test_a_keeper_with_older_code_is_replaced_while_nothing_runs_in_it(self):
        old = self.keep(code_version="old")
        started = []
        kept = keeper.KeptTerminals(self.path, start=lambda: started.append(self.keep()))
        self.assertEqual(kept.list(), [])
        self.assertTrue(old.keeper.is_quitting.is_set())
        # a new one comes with the next terminal
        self.assertEqual(started, [])
        kept.start(self.folder)
        self.assertEqual(len(started), 1)
        self.assertFalse(kept.is_outdated)

    def test_a_keeper_with_older_code_stays_while_terminals_run_in_it(self):
        old = self.keep(code_version="old")
        old.terms.start(self.folder)
        kept = keeper.KeptTerminals(self.path, start=lambda: self.fail("its terminals would end"))
        self.assertEqual(len(kept.list()), 1)
        self.assertFalse(old.keeper.is_quitting.is_set())
        self.assertTrue(kept.is_outdated)

    def test_quitting_asks_first_while_terminals_run(self):
        running = self.keep()
        running.terms.start(self.folder)
        self.assertEqual(keeper.ask(running.info, "quit"), {"ok": False, "live": 1})
        self.assertFalse(running.keeper.is_quitting.is_set())
        self.assertEqual(keeper.ask(running.info, "quit", {"force": True}), {"ok": True, "live": 1})
        self.assertTrue(running.keeper.is_quitting.is_set())

    def test_the_board_can_end_the_keeper_and_everything_in_it(self):
        running = self.keep()
        kept = keeper.KeptTerminals(self.path, start=lambda: self.keep())
        self.assertFalse(kept.is_running)
        kept.start(self.folder)
        kept.start(self.folder)
        self.assertTrue(kept.is_running)
        self.assertEqual(kept.stop_keeper(), 2)
        self.assertTrue(running.keeper.is_quitting.is_set())
        self.assertFalse(kept.is_running)
        # nothing runs any more, so nothing to end; the server's route says how many it ended
        self.assertEqual(kept.stop_keeper(), 0)
        import serve
        self.assertEqual(serve.terminal_action(kept, "terminal-keeper-stop", {}), {"ok": True, "ended": 0})

    def test_a_keeper_nobody_can_reach_says_so(self):
        kept = keeper.KeptTerminals(self.path, start=lambda: None)
        keeper_wait, keeper.START_WAIT_S = keeper.START_WAIT_S, 0.2
        try:
            self.assertEqual(kept.start(self.folder), (None, "CCC's keeper did not start. See ~/.claude/ccc/keeper.log."))
            self.assertEqual(kept.list(), [])
        finally:
            keeper.START_WAIT_S = keeper_wait


if __name__ == "__main__":
    unittest.main()
