import base64
import json
import os
import re
import signal
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

import answer_from_ccc
import approve_from_ccc
import prompt_seen
import editors
import mentions
import serve
import terminals


class ReadSessionsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, payload, age_s=0):
        path = self.dir / name
        path.write_text(payload if isinstance(payload, str) else json.dumps(payload))
        when = time.time() - age_s
        os.utime(path, (when, when))

    def test_reads_snapshots_newest_first(self):
        self.write("a.json", {"version": 1, "sessionId": "a", "updatedAt": 1})
        self.write("b.json", {"version": 1, "sessionId": "b", "updatedAt": 2})
        ids = [s["sessionId"] for s in serve.read_sessions(self.dir)]
        self.assertEqual(ids, ["b", "a"])

    def test_skips_broken_and_foreign_files_but_keeps_old_ones(self):
        self.write("broken.json", "{not json")
        self.write("old.json", {"version": 1, "sessionId": "old"}, age_s=30 * 24 * 3600)
        self.write("future.json", {"version": 2, "sessionId": "future"})
        self.write("list.json", [1, 2, 3])
        self.write("notes.txt", {"version": 1, "sessionId": "txt"})
        self.assertEqual([s["sessionId"] for s in serve.read_sessions(self.dir)], ["old"])

    def test_reads_at_most_the_newest_files(self):
        for i in range(5):
            self.write(f"s{i}.json", {"version": 1, "sessionId": f"s{i}", "updatedAt": i}, age_s=100 - i)
        self.assertEqual([s["sessionId"] for s in serve.read_sessions(self.dir, limit=2)], ["s4", "s3"])

    def test_skips_oversized_files(self):
        self.write("big.json", json.dumps({"version": 1, "pad": "x" * serve.MAX_FILE_BYTES}))
        self.assertEqual(serve.read_sessions(self.dir), [])

    def test_missing_directory_gives_no_sessions(self):
        self.assertEqual(serve.read_sessions(self.dir / "nope"), [])


class CavemanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name) / "caveman"
        self.caveman = serve.Caveman(self.folder)

    def tearDown(self):
        self.tmp.cleanup()

    def test_nothing_chosen_is_off_everywhere(self):
        self.assertEqual(self.caveman.choices(), {"default": "off", "sessions": {}})

    def test_a_session_keeps_its_own_level_where_the_mod_reads_it(self):
        self.caveman.choose("abc-1", "ultra")
        self.assertEqual(json.loads((self.folder / "abc-1.json").read_text()), {"level": "ultra"})
        self.assertEqual(self.caveman.choices()["sessions"], {"abc-1": "ultra"})

    def test_a_session_set_to_the_default_follows_the_default(self):
        self.caveman.choose(None, "full")
        self.caveman.choose("abc-1", "off")
        self.assertEqual(self.caveman.choices(), {"default": "full", "sessions": {"abc-1": "off"}})
        self.caveman.choose("abc-1", "full")
        self.assertFalse((self.folder / "abc-1.json").exists())
        self.assertEqual(self.caveman.choices(), {"default": "full", "sessions": {}})

    def test_a_session_switched_off_keeps_its_file_for_its_mod(self):
        self.caveman.choose("abc-1", "ultra")
        self.caveman.choose("abc-1", "off")
        self.assertEqual(self.caveman.choices()["sessions"], {"abc-1": "off"})

    def test_broken_or_unknown_files_are_left_out(self):
        self.folder.mkdir()
        (self.folder / "x.json").write_text("nope")
        (self.folder / "y.json").write_text('{"level": "wenyan-ultra"}')
        self.assertEqual(self.caveman.choices(), {"default": "off", "sessions": {}})

    def test_only_known_levels_and_safe_ids_are_taken(self):
        self.assertEqual(serve.read_caveman_request(b'{"sessionId": "abc-1", "level": "lite"}'), ("abc-1", "lite"))
        self.assertEqual(serve.read_caveman_request(b'{"level": "full"}'), (None, "full"))
        self.assertIsNone(serve.read_caveman_request(b'{"sessionId": "../x", "level": "lite"}'))
        self.assertIsNone(serve.read_caveman_request(b'{"sessionId": "abc", "level": "loud"}'))
        self.assertIsNone(serve.read_caveman_request(b'not json'))


class ThinkingUpdatesTest(unittest.TestCase):
    def test_notes_between_steps_show_as_the_app_shows_them(self):
        content = [{"type": "thinking", "thinking": "The manifest is stale.\n\n", "signature": "x"}, {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls"}}]
        items = serve.assistant_items(content, 5, True)
        self.assertEqual([item["kind"] for item in items], ["claude", "tool"])
        self.assertEqual(items[0]["text"], "The manifest is stale.")
        self.assertTrue(items[0]["note"])

    def test_other_thinking_stays_hidden(self):
        content = [{"type": "thinking", "thinking": "private reasoning", "signature": "x"}]
        self.assertEqual(serve.assistant_items(content, 5), [])
        self.assertEqual(serve.assistant_items([{"type": "thinking", "thinking": "  ", "signature": "x"}], 5, True), [])


class CommandLineTest(unittest.TestCase):
    def test_a_skill_shows_as_typed(self):
        text = "<command-message>cavecrew</command-message>\n<command-name>/cavecrew</command-name>\n<command-args>suggest a file for me to modify</command-args>"
        self.assertEqual(serve.command_line(text), "/cavecrew suggest a file for me to modify")
        self.assertEqual(serve.user_items(text, 5)[0]["text"], "/cavecrew suggest a file for me to modify")

    def test_a_command_without_words_is_its_name(self):
        self.assertEqual(serve.command_line("<command-message>caveman</command-message>\n<command-name>/caveman</command-name>\n<command-args></command-args>"), "/caveman")
        self.assertEqual(serve.command_line("<command-name>caveman</command-name>"), "/caveman")

    def test_plain_words_are_no_command(self):
        self.assertIsNone(serve.command_line("Fix the <command-args> parser"))


class BoardFilesTest(unittest.TestCase):
    def test_every_module_the_board_imports_is_served(self):
        served = set(serve.BOARD_FILES.values())
        found = set()
        for name in [n for n in served if n.endswith(".js")]:
            text = (serve.BOARD_DIR / name).read_text(encoding="utf-8")
            for imported in re.findall(r"from '\./([\w-]+\.js)'", text):
                found.add(imported)
                self.assertIn(imported, served, f"{name} imports {imported}, which the server does not serve")
        self.assertIn("dragon.js", found)
        self.assertIn("board-logic.js", found)


class BoardVersionTest(unittest.TestCase):
    def test_the_mark_changes_when_a_board_file_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            for name in set(serve.BOARD_FILES.values()):
                (folder / name).write_text("x")
            first = serve.board_version(folder)
            self.assertEqual(serve.board_version(folder), first)
            (folder / "chat.js").write_text("changed")
            self.assertNotEqual(serve.board_version(folder), first)
            (folder / "chat.js").unlink()
            self.assertEqual(len(serve.board_version(folder)), 12)

    def test_the_board_payload_carries_the_mark(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = serve.board_payload(Path(tmp), serve.Removals(Path(tmp) / "r.json"), serve.Transcripts(Path(tmp)), prompts_dir=Path(tmp), approvals_dir=Path(tmp))
            self.assertEqual(payload["boardVersion"], serve.board_version())


class HostTest(unittest.TestCase):
    def test_only_the_boards_own_address(self):
        self.assertTrue(serve.is_local_host("127.0.0.1:8765", 8765))
        self.assertTrue(serve.is_local_host("localhost:8765", 8765))
        self.assertFalse(serve.is_local_host("evil.example:8765", 8765))
        self.assertFalse(serve.is_local_host("127.0.0.1:9999", 8765))
        self.assertFalse(serve.is_local_host("", 8765))



class TranscriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.projects = Path(self.tmp.name)
        (self.projects / "-Users-x-proj").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def transcript(self, session_id, lines):
        path = self.projects / "-Users-x-proj" / f"{session_id}.jsonl"
        path.write_text("\n".join(json.dumps(line) for line in lines) + "\n")
        return path

    def test_reads_the_newest_name_and_mode(self):
        self.transcript("s1", [
            {"type": "custom-title", "customTitle": "Old name", "sessionId": "s1"},
            {"type": "user", "permissionMode": "default"},
            {"type": "custom-title", "customTitle": "Claude Code mods \"and\" skills", "sessionId": "s1"},
            {"type": "user", "permissionMode": "auto"},
        ])
        facts = serve.Transcripts(self.projects).describe("s1")
        self.assertEqual(facts, {"title": 'Claude Code mods "and" skills', "permissionMode": "auto"})

    def test_reads_where_the_session_was_started(self):
        self.transcript("s9", [
            {"type": "user", "entrypoint": "claude-desktop", "permissionMode": "auto"},
            {"type": "assistant", "entrypoint": "claude-vscode"},
        ])
        self.assertEqual(serve.Transcripts(self.projects).describe("s9")["entrypoint"], "claude-vscode")
        self.assertEqual(serve.facts_in('{"entrypoint": "Bad Value!"}'), {})

    def test_finds_facts_beyond_the_tail(self):
        path = self.transcript("s2", [{"type": "custom-title", "customTitle": "Early name", "sessionId": "s2"}])
        with path.open("a") as handle:
            handle.write(json.dumps({"type": "assistant", "pad": "x" * (serve.TAIL_BYTES + 10)}) + "\n")
        self.assertEqual(serve.Transcripts(self.projects).describe("s2"), {"title": "Early name"})

    def test_unknown_unsafe_or_nameless_sessions_give_nothing(self):
        self.transcript("s3", [{"type": "user", "text": "hi"}])
        transcripts = serve.Transcripts(self.projects)
        self.assertEqual(transcripts.describe("s3"), {})
        self.assertEqual(transcripts.describe("missing"), {})
        self.assertEqual(transcripts.describe("../../etc/passwd"), {})
        self.assertEqual(transcripts.describe(None), {})

    def test_a_renamed_session_is_read_again(self):
        path = self.transcript("s4", [{"type": "custom-title", "customTitle": "First", "sessionId": "s4"}])
        transcripts = serve.Transcripts(self.projects)
        self.assertEqual(transcripts.describe("s4")["title"], "First")
        with path.open("a") as handle:
            handle.write(json.dumps({"type": "custom-title", "customTitle": "Renamed", "sessionId": "s4"}) + "\n")
        self.assertEqual(transcripts.describe("s4")["title"], "Renamed")

    def test_snapshots_get_the_facts_merged_in(self):
        self.transcript("s5", [{"type": "custom-title", "customTitle": "Named", "sessionId": "s5"}])
        merged = serve.with_transcript_facts([{"sessionId": "s5"}, {"sessionId": "other"}], serve.Transcripts(self.projects))
        self.assertEqual(merged, [{"sessionId": "s5", "title": "Named"}, {"sessionId": "other"}])



class EndedTaskTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.projects = Path(self.tmp.name)
        (self.projects / "-Users-x-proj").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    @staticmethod
    def report(tool_use_id, status, as_list=False):
        text = f"<task-notification>\n<task-id>x1</task-id>\n<tool-use-id>{tool_use_id}</tool-use-id>\n<status>{status}</status>\n</task-notification>"
        content = [{"type": "text", "text": text}] if as_list else text
        return {"type": "user", "timestamp": "2026-10-19T14:30:00.000Z", "message": {"role": "user", "content": content}}

    def write(self, session_id, records):
        path = self.projects / "-Users-x-proj" / f"{session_id}.jsonl"
        path.write_text("\n".join(json.dumps(record) for record in records) + "\n")

    def test_reads_the_reports_claude_code_sent(self):
        text = "\n".join(json.dumps(r) for r in [self.report("w1", "completed"), self.report("t2", "killed", as_list=True), self.report("t3", "running")])
        self.assertEqual(serve.ended_tasks_in(text), {
            "w1": {"status": "done", "at": 1792420200000},
            "t2": {"status": "failed", "at": 1792420200000},
        })

    def test_a_report_taken_in_while_claude_works_counts_too(self):
        report = self.report("b1", "completed")
        queued = {"type": "attachment", "timestamp": report["timestamp"], "attachment": {"type": "queued_command", "prompt": report["message"]["content"]}}
        other = {"type": "attachment", "timestamp": report["timestamp"], "attachment": {"type": "file", "prompt": report["message"]["content"]}}
        quoting = {"type": "attachment", "timestamp": report["timestamp"], "attachment": {"type": "queued_command", "prompt": "see " + report["message"]["content"]}}
        text = "\n".join(json.dumps(r) for r in [queued, other, quoting])
        self.assertEqual(serve.ended_tasks_in(text), {"b1": {"status": "done", "at": 1792420200000}})

    def test_a_text_that_only_quotes_a_report_counts_for_nothing(self):
        quoted = self.report("w1", "completed")
        quoted["message"]["content"] = "look at this: " + quoted["message"]["content"]
        from_claude = {**self.report("w2", "completed"), "type": "assistant"}
        broken = '{"type": "user", "message": "<task-notification>'
        text = "\n".join([json.dumps(quoted), json.dumps(from_claude), broken])
        self.assertEqual(serve.ended_tasks_in(text), {})

    def test_open_runs_it_names_are_shown_ended_with_their_agents(self):
        runs = [
            {"id": "w1", "kind": "workflow", "status": "started"},
            {"id": "a1", "kind": "agent", "status": "running", "parentId": "w1"},
            {"id": "a2", "kind": "agent", "status": "done", "parentId": "w1", "endedAt": 5},
            {"id": "t9", "kind": "agent", "status": "running"},
            "not a run",
        ]
        settled = serve.settle_runs(runs, {"w1": {"status": "done", "at": 9}})
        self.assertEqual(settled, [
            {"id": "w1", "kind": "workflow", "status": "done", "endedAt": 9},
            {"id": "a1", "kind": "agent", "status": "done", "parentId": "w1", "endedAt": 9},
            {"id": "a2", "kind": "agent", "status": "done", "parentId": "w1", "endedAt": 5},
            {"id": "t9", "kind": "agent", "status": "running"},
            "not a run",
        ])
        self.assertEqual(serve.settle_runs([{"id": "w1", "status": "started"}], {"w1": {"status": "failed", "at": None}}), [{"id": "w1", "status": "failed"}])

    def test_a_report_far_back_in_the_transcript_still_counts(self):
        self.write("s2", [self.report("w1", "completed")])
        path = self.projects / "-Users-x-proj" / "s2.jsonl"
        with path.open("a") as handle:
            handle.write(json.dumps({"type": "assistant", "pad": "x" * (serve.TAIL_BYTES + 10)}) + "\n")
        facts = serve.Transcripts(self.projects).describe("s2")
        self.assertEqual(facts["endedTasks"], {"w1": {"status": "done", "at": 1792420200000}})

    def test_reports_added_later_are_read_and_a_rewritten_file_starts_over(self):
        self.write("s3", [{"type": "user", "message": {"content": "hi"}}])
        path = self.projects / "-Users-x-proj" / "s3.jsonl"
        transcripts = serve.Transcripts(self.projects)
        self.assertNotIn("endedTasks", transcripts.describe("s3"))
        with path.open("a") as handle:
            handle.write(json.dumps(self.report("w1", "completed")) + "\n")
            handle.write('{"type": "user", "message": "half a li')
        self.assertEqual(list(transcripts.describe("s3")["endedTasks"]), ["w1"])
        with path.open("a") as handle:
            handle.write('ne"}\n' + json.dumps(self.report("w2", "failed")) + "\n")
        self.assertEqual(sorted(transcripts.describe("s3")["endedTasks"]), ["w1", "w2"])
        self.write("s3", [self.report("w3", "completed")])
        self.assertEqual(list(transcripts.describe("s3")["endedTasks"]), ["w3"])

    def test_the_board_gets_the_runs_settled_and_no_extra_field(self):
        self.write("s1", [{"type": "custom-title", "customTitle": "Named", "sessionId": "s1"}, self.report("w1", "completed")])
        transcripts = serve.Transcripts(self.projects)
        session = {"sessionId": "s1", "runs": [{"id": "w1", "status": "started"}]}
        merged = serve.with_transcript_facts([session], transcripts)
        self.assertEqual(merged, [{"sessionId": "s1", "title": "Named", "runs": [{"id": "w1", "status": "done", "endedAt": 1792420200000}]}])
        self.assertEqual(serve.with_transcript_facts([session], transcripts), merged)
        self.assertEqual(session["runs"], [{"id": "w1", "status": "started"}])


class AppSessionsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / "acc" / "org"
        self.dir.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, data):
        path = self.dir / name
        path.write_text(json.dumps(data) if not isinstance(data, str) else data)
        return path

    def test_reads_the_apps_own_id_for_each_session(self):
        self.write("local_aaa-1.json", {"sessionId": "local_aaa-1", "cliSessionId": "0fdd9824-442d", "title": "x"})
        self.write("local_bbb.json", {"sessionId": "local_bbb", "cliSessionId": "abc"})
        self.assertEqual(serve.AppSessions(Path(self.tmp.name)).ids(), {"0fdd9824-442d": "local_aaa-1", "abc": "local_bbb"})

    def test_odd_or_broken_files_give_nothing(self):
        self.write("local_bad1.json", {"sessionId": "not-local", "cliSessionId": "abc"})
        self.write("local_bad2.json", {"sessionId": "local_x", "cliSessionId": "../../etc"})
        self.write("local_bad3.json", "{broken")
        self.write("local_bad4.json", ["a list"])
        self.write("other.json", {"sessionId": "local_y", "cliSessionId": "abc"})
        self.assertEqual(serve.AppSessions(Path(self.tmp.name)).ids(), {})
        self.assertEqual(serve.AppSessions(Path(self.tmp.name) / "missing").ids(), {})

    def test_a_changed_file_is_read_again(self):
        path = self.write("local_c.json", {"sessionId": "local_c", "cliSessionId": "one"})
        sessions = serve.AppSessions(Path(self.tmp.name))
        self.assertEqual(sessions.ids(), {"one": "local_c"})
        path.write_text(json.dumps({"sessionId": "local_c", "cliSessionId": "two"}))
        os.utime(path, ns=(1, 2_000_000_000_000_000_000))
        self.assertEqual(sessions.ids(), {"two": "local_c"})

    def test_snapshots_get_the_apps_id_when_it_has_one(self):
        merged = serve.with_app_ids([{"sessionId": "a"}, {"sessionId": "b"}], {"a": "local_1"})
        self.assertEqual(merged, [{"sessionId": "a", "appSessionId": "local_1"}, {"sessionId": "b"}])


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


class ChatTest(unittest.TestCase):
    def test_reads_prompts_answers_and_steps_in_order(self):
        lines = [json.dumps(r) for r in [
            {"type": "user", "timestamp": "2026-10-19T14:30:00Z", "message": {"content": "Fixa kartan<system-reminder>dold</system-reminder>"}},
            {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "hmm"}, {"type": "text", "text": "Let me check."}]}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": "git status\nls"}}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "content": "ok"}]}},
            {"type": "user", "message": {"content": [{"type": "text", "text": "titta"}, {"type": "image", "source": {}}]}},
            {"type": "user", "isMeta": True, "message": {"content": "meta"}},
            {"type": "assistant", "isSidechain": True, "message": {"content": [{"type": "text", "text": "agentens"}]}},
            {"type": "user", "message": {"content": "<task-notification><status>completed</status></task-notification>"}},
            {"type": "custom-title", "customTitle": "x"},
        ]] + ["not json"]
        self.assertEqual(serve.conversation(lines), [
            {"kind": "you", "text": "Fixa kartan", "images": 0, "at": 1792420200000},
            {"kind": "claude", "text": "Let me check.", "at": None},
            {"kind": "tool", "text": "$ git status", "at": None, "tool": "Bash"},
            {"kind": "you", "text": "titta", "images": 1, "at": None},
            {"kind": "note", "text": "Background work reported back", "at": None},
        ])

    def test_a_message_sent_from_ccc_shows_its_images_as_a_count(self):
        prompt = "What do you see?\n\nImages I added (open them with the Read tool):\n- /u/a.png\n- /u/b.png"
        lines = [json.dumps({"type": "user", "message": {"content": prompt}}), json.dumps({"type": "user", "message": {"content": "Images I added (open them with the Read tool):\n- /u/c.png"}})]
        self.assertEqual(serve.conversation(lines), [
            {"kind": "you", "text": "What do you see?", "images": 2, "at": None, "pictures": ["upload:a.png", "upload:b.png"]},
            {"kind": "you", "text": "", "images": 1, "at": None, "pictures": ["upload:c.png"]},
        ])

    def test_what_the_person_writes_while_claude_works_shows_too(self):
        lines = [json.dumps(r) for r in [
            {"type": "queue-operation", "operation": "enqueue", "content": "first"},
            {"type": "queue-operation", "operation": "dequeue"},
            {"type": "user", "message": {"content": "first"}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "Jobbar."}]}},
            {"type": "queue-operation", "operation": "enqueue", "content": "mitt i"},
            {"type": "attachment", "attachment": {"type": "queued_command", "prompt": "mitt i<system-reminder>x</system-reminder>", "commandMode": "prompt"}},
            {"type": "queue-operation", "operation": "remove", "reason": "absorbed_mid_turn"},
            {"type": "attachment", "attachment": {"type": "file", "prompt": "not a prompt"}},
            {"type": "queue-operation", "operation": "enqueue", "content": "waiting"},
            {"type": "queue-operation", "operation": "dequeue"},
            {"type": "queue-operation", "operation": "dequeue"},
            {"type": "queue-operation", "operation": "enqueue", "content": "last in the queue"},
        ]]
        self.assertEqual([(i["kind"], i["text"], i.get("queued", False)) for i in serve.conversation(lines)], [
            ("you", "first", False),
            ("claude", "Jobbar.", False),
            ("you", "mitt i", False),
            ("you", "last in the queue", True),
        ])

    def test_only_the_latest_exchanges_are_kept(self):
        lines = [json.dumps({"type": "user", "message": {"content": f"q{i}"}}) for i in range(serve.CHAT_ITEMS + 20)]
        items = serve.conversation(lines)
        self.assertEqual(len(items), serve.CHAT_ITEMS)
        self.assertEqual(items[-1]["text"], f"q{serve.CHAT_ITEMS + 19}")

    def test_each_step_gets_one_short_line(self):
        self.assertEqual(serve.describe_tool("Read", {"file_path": "/a/b/board.js"}), "Read board.js")
        self.assertEqual(serve.describe_tool("Grep", {"pattern": "TODO"}), "Grep TODO")
        self.assertEqual(serve.describe_tool("Agent", {"description": "Granska"}), "Agent: Granska")
        self.assertEqual(serve.describe_tool("mcp__ccd_turn__update_plan", {}), "update plan")
        self.assertEqual(serve.describe_tool(None, None), "tool")
        self.assertEqual(serve.describe_tool("Bash", {"command": "x" * 500}), "$ " + "x" * 160)

    def test_reads_the_end_of_a_transcript_from_disk(self):
        with tempfile.TemporaryDirectory() as tmp:
            projects = Path(tmp)
            (projects / "p").mkdir()
            (projects / "p" / "s1.jsonl").write_text(json.dumps({"type": "user", "message": {"content": "hi"}}) + "\n")
            transcripts = serve.Transcripts(projects)
            inbox = serve.Inbox(projects / "inbox", projects / "uploads")
            self.assertEqual(serve.chat_payload("s1", transcripts, inbox)["items"][0]["text"], "hi")
            self.assertEqual(serve.chat_payload("../x", transcripts, inbox), {"items": [], "pending": []})
            self.assertEqual(serve.chat_payload("missing", transcripts, inbox), {"items": [], "pending": []})


class QuestionTest(unittest.TestCase):
    ASK = {
        "type": "assistant",
        "timestamp": "2026-10-20T11:33:42Z",
        "message": {"content": [{"type": "tool_use", "id": "toolu_q1", "name": "AskUserQuestion", "input": {"questions": [
            {"question": "Which tokens?", "header": "Tokens", "multiSelect": False, "options": [
                {"label": "Output", "description": "What Claude writes", "preview": "x" * 9000},
                {"label": "Allt"},
                {"label": "  "},
                "nope",
            ]},
            {"question": "And more?", "multiSelect": True, "options": []},
            {"question": ""},
        ]}}]},
    }

    def answer(self, answers=None, is_error=False):
        record = {"type": "user", "timestamp": "2026-10-20T11:35:22Z", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_q1", "content": "The user answered", "is_error": is_error}]}}
        if answers is not None:
            record["toolUseResult"] = {"questions": [], "answers": answers}
        return json.dumps(record)

    def test_a_question_box_comes_with_its_questions_and_options(self):
        [item] = serve.conversation([json.dumps(self.ASK)])
        self.assertEqual(item["kind"], "question")
        self.assertEqual(item["toolId"], "toolu_q1")
        self.assertEqual(item["questions"], [
            {"question": "Which tokens?", "header": "Tokens", "multiSelect": False, "options": [{"label": "Output", "description": "What Claude writes"}, {"label": "Allt", "description": ""}]},
            {"question": "And more?", "header": "", "multiSelect": True, "options": []},
        ])
        self.assertNotIn("answers", item)

    def test_the_answer_is_read_per_question(self):
        [item] = serve.conversation([json.dumps(self.ASK), self.answer({"Which tokens?": "it can stand apart"})])
        self.assertEqual(item["answers"], ["it can stand apart", ""])
        self.assertNotIn("isDeclined", item)

    def test_a_box_turned_down_or_cut_short_is_marked(self):
        [item] = serve.conversation([json.dumps(self.ASK), self.answer(is_error=True)])
        self.assertTrue(item["isDeclined"])
        [item] = serve.conversation([json.dumps(self.ASK), self.answer()])
        self.assertTrue(item["isDeclined"])

    def test_odd_input_gives_an_empty_box(self):
        self.assertEqual(serve.question_item(None, 5), {"kind": "question", "questions": [], "at": 5})
        self.assertEqual(serve.question_item({"questions": "x"}, 5)["questions"], [])


class AnswerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.projects = Path(self.tmp.name) / "projects"
        folder = self.projects / "-Users-me-repo"
        folder.mkdir(parents=True)
        self.transcript = folder / "s1.jsonl"
        self.transcript.write_text(json.dumps(QuestionTest.ASK) + "\n")
        self.answers = serve.Answers(Path(self.tmp.name) / "answers", serve.Transcripts(self.projects))

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_plain_request_names_the_box_and_an_answer_per_question(self):
        body = json.dumps({"sessionId": "s1", "toolId": "toolu_q1", "answers": [" Output ", "Yes"]}).encode()
        self.assertEqual(serve.read_answer_request(body), ("s1", "toolu_q1", ["Output", "Yes"]))
        for bad in ({"sessionId": "../x", "toolId": "toolu_q1", "answers": ["a"]}, {"sessionId": "s1", "toolId": "t q", "answers": ["a"]},
                    {"sessionId": "s1", "toolId": "toolu_q1", "answers": []}, {"sessionId": "s1", "toolId": "toolu_q1", "answers": ["  "]},
                    {"sessionId": "s1", "toolId": "toolu_q1", "answers": [7]}, {"sessionId": "s1", "toolId": "toolu_q1", "answers": ["a"] * 5},
                    {"sessionId": "s1", "toolId": "toolu_q1", "answers": ["x" * (serve.ANSWER_MAX + 1)]}):
            self.assertIsNone(serve.read_answer_request(json.dumps(bad).encode()))
        self.assertIsNone(serve.read_answer_request(b"nope"))

    def test_the_answer_is_left_for_the_hook_keyed_by_question(self):
        self.assertEqual(self.answers.give("s1", "toolu_q1", ["Output", "Yes"], 5000), "")
        left = json.loads((Path(self.tmp.name) / "answers" / "s1.json").read_text())
        self.assertEqual(left, {"toolId": "toolu_q1", "questions": ["Which tokens?", "And more?"], "answers": {"Which tokens?": "Output", "And more?": "Yes"}, "at": 5000})
        self.assertEqual(answer_from_ccc.read_answer(Path(self.tmp.name) / "answers" / "s1.json", left["questions"], 5000), left["answers"])

    def test_words_of_your_own_answer_the_whole_box(self):
        body = json.dumps({"sessionId": "s1", "toolId": "toolu_q1", "message": " Neither, use main "}).encode()
        self.assertEqual(serve.read_answer_request(body), ("s1", "toolu_q1", "Neither, use main"))
        self.assertIsNone(serve.read_answer_request(json.dumps({"sessionId": "s1", "toolId": "toolu_q1", "message": "  "}).encode()))
        self.assertEqual(self.answers.give("s1", "toolu_q1", "Neither, use main", 5000), "")
        path = Path(self.tmp.name) / "answers" / "s1.json"
        read = answer_from_ccc.read_answer(path, ["Which tokens?", "And more?"], 5000)
        self.assertEqual(read, {"message": "Neither, use main"})
        self.assertEqual(answer_from_ccc.decision({}, read)["hookSpecificOutput"]["decision"], {"behavior": "deny", "message": answer_from_ccc.FEEDBACK + "Neither, use main"})

    def test_an_answer_for_a_box_that_is_gone_answered_or_short_is_refused(self):
        self.assertEqual(self.answers.give("s1", "toolu_other", ["a", "b"], 1), "That question is no longer in the chat.")
        self.assertEqual(self.answers.give("nobody", "toolu_q1", ["a", "b"], 1), "That question is no longer in the chat.")
        self.assertEqual(self.answers.give("s1", "toolu_q1", ["a"], 1), "Answer every question.")
        with self.transcript.open("a") as handle:
            handle.write(QuestionTest().answer({"Which tokens?": "Output", "And more?": "No"}) + "\n")
        self.assertEqual(self.answers.give("s1", "toolu_q1", ["a", "b"], 1), "That question has already been answered.")
        self.assertFalse((Path(self.tmp.name) / "answers" / "s1.json").exists())


class AnswerHookTest(unittest.TestCase):
    NOTICE = {"session_id": "s1", "tool_name": "AskUserQuestion", "transcript_path": "/none", "tool_input": {"questions": [{"question": "Colour?", "options": [{"label": "Red"}, {"label": "Blue"}]}]}}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.old_dir = answer_from_ccc.ANSWERS_DIR
        answer_from_ccc.ANSWERS_DIR = self.dir

    def tearDown(self):
        answer_from_ccc.ANSWERS_DIR = self.old_dir
        self.tmp.cleanup()

    def leave(self, answers, at, questions=("Colour?",)):
        (self.dir / "s1.json").write_text(json.dumps({"questions": list(questions), "answers": answers, "at": at}))

    def test_only_a_main_thread_question_box_is_answered(self):
        self.assertEqual(answer_from_ccc.box_of(self.NOTICE), ("s1", self.NOTICE["tool_input"], ["Colour?"]))
        for bad in ({**self.NOTICE, "tool_name": "Bash"}, {**self.NOTICE, "agent_id": "a1"}, {**self.NOTICE, "session_id": "../x"},
                    {**self.NOTICE, "tool_input": {"questions": []}}, {**self.NOTICE, "tool_input": {"questions": [{"question": ""}]}}, None):
            self.assertIsNone(answer_from_ccc.box_of(bad))

    def test_an_answer_counts_only_for_the_same_questions_and_not_from_long_before(self):
        self.leave({"Colour?": "Blue"}, 100_000)
        self.assertEqual(answer_from_ccc.read_answer(self.dir / "s1.json", ["Colour?"], 100_000), {"Colour?": "Blue"})
        self.assertIsNone(answer_from_ccc.read_answer(self.dir / "s1.json", ["Annan?"], 100_000))
        self.assertIsNone(answer_from_ccc.read_answer(self.dir / "s1.json", ["Colour?"], 100_000 + 61_000))
        self.leave({"Colour?": 3}, 100_000)
        self.assertIsNone(answer_from_ccc.read_answer(self.dir / "s1.json", ["Colour?"], 100_000))
        self.assertIsNone(answer_from_ccc.read_answer(self.dir / "none.json", ["Colour?"], 1))

    def test_the_answer_goes_to_claude_once_as_the_box_answers(self):
        clock = [1000.0]
        self.leave({"Colour?": "Blue"}, 1_000_000)
        decision = answer_from_ccc.wait_for_answer("s1", self.NOTICE["tool_input"], ["Colour?"], "/none", clock=lambda: clock[0], sleep=lambda s: None)
        self.assertEqual(decision["hookSpecificOutput"]["decision"], {"behavior": "allow", "updatedInput": {**self.NOTICE["tool_input"], "answers": {"Colour?": "Blue"}}})
        self.assertEqual(decision["hookSpecificOutput"]["hookEventName"], "PermissionRequest")
        self.assertFalse((self.dir / "s1.json").exists())
        self.assertTrue((self.dir / "s1.taken").exists())

    def test_it_stops_when_the_box_was_answered_in_the_app(self):
        transcript = self.dir / "t.jsonl"
        ask = {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "toolu_x", "name": "AskUserQuestion", "input": self.NOTICE["tool_input"]}]}}
        transcript.write_text(json.dumps(ask) + "\n")
        self.assertFalse(answer_from_ccc.answered_elsewhere(str(transcript), ["Colour?"]))
        done = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_x", "content": "answered"}]}}
        with transcript.open("a") as handle:
            handle.write(json.dumps(done) + "\n")
        self.assertTrue(answer_from_ccc.answered_elsewhere(str(transcript), ["Colour?"]))
        self.assertFalse(answer_from_ccc.answered_elsewhere(str(transcript), ["Annan?"]))
        self.assertFalse(answer_from_ccc.answered_elsewhere("/no/such/file", ["Colour?"]))
        clock = [0.0]

        def tick(_):
            clock[0] += 1

        self.assertIsNone(answer_from_ccc.wait_for_answer("s1", self.NOTICE["tool_input"], ["Colour?"], str(transcript), clock=lambda: clock[0], sleep=tick))
        self.assertLess(clock[0], 10)

    def test_the_hook_ends_at_once_outside_the_app_and_vs_code_and_never_fails(self):
        script = str(Path(__file__).resolve().parent / "answer_from_ccc.py")
        for entry, given in (("cli", json.dumps(self.NOTICE)), ("claude-desktop", "not json"), ("claude-desktop", json.dumps({**self.NOTICE, "tool_name": "Bash"}))):
            env = {**os.environ, "CLAUDE_CODE_ENTRYPOINT": entry, "CCC_ANSWERS_DIR": str(self.dir)}
            started = time.time()
            done = subprocess.run(["/usr/bin/python3", script], input=given, text=True, env=env, capture_output=True, timeout=20)
            self.assertEqual((done.returncode, done.stdout, done.stderr), (0, "", ""))
            self.assertLess(time.time() - started, 5)


class StartTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.projects = self.root / "projects"
        self.home = self.root / "home"
        (self.home / "Library" / "scratch").mkdir(parents=True)
        (self.home / "shop").mkdir()
        (self.home / "blog").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def transcript(self, name, cwd, age_s):
        path = self.projects / "-x" / f"{name}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"type": "user", "cwd": cwd, "message": {"content": "hi"}}) + "\n")
        when = time.time() - age_s
        os.utime(path, (when, when))

    def test_recent_folders_come_newest_first_without_passing_ones(self):
        self.transcript("a", str(self.home / "shop"), 100)
        self.transcript("b", str(self.home / "blog"), 10)
        self.transcript("c", str(self.home / "shop"), 5)
        self.transcript("d", str(self.home / "Library" / "scratch"), 1)
        self.transcript("e", "/no/such/folder", 2)
        self.transcript("f", "relative/path", 3)
        passing = (f"{self.home}/Library/",)
        found = serve.recent_folders(self.projects, passing=passing)
        self.assertEqual(found, [str(self.home / "shop"), str(self.home / "blog")])
        self.assertEqual(serve.recent_folders(self.projects, limit=1, passing=passing), [str(self.home / "shop")])

    def test_a_start_names_a_folder_on_this_mac_and_where(self):
        folder = str(self.home / "shop")
        read = lambda fields: serve.read_start_request(json.dumps(fields).encode())
        usual = terminals.chosen_app("auto", terminals.installed_apps())
        self.assertEqual(read({"folder": folder, "where": "terminal", "prompt": " hi\nthere "}), ((os.path.realpath(folder), "terminal", "hi\nthere", usual, ""), ""))
        self.assertEqual(read({"folder": folder, "where": "app", "prompt": " hi "}), ((os.path.realpath(folder), "app", "hi", usual, ""), ""))
        # a mode goes with a terminal start; the app's link takes none, and only the modes listed are taken
        self.assertEqual(read({"folder": folder, "where": "terminal", "mode": "auto"})[0][4], "auto")
        self.assertEqual(read({"folder": folder, "where": "app", "mode": "auto"})[0][4], "")
        self.assertEqual(read({"folder": folder, "where": "terminal", "mode": "bypassPermissions; rm -rf ~"}), (None, "Pick one of the modes in the list."))
        self.assertEqual(read({"folder": folder, "where": "terminal", "app": "terminal"})[0][3], "terminal")
        self.assertEqual(read({"folder": folder, "where": "terminal", "app": "rm -rf"})[0][3], usual)
        self.assertEqual(read({"folder": "/no/such", "where": "app"}), (None, "That folder is not on this Mac."))
        self.assertEqual(read({"folder": "relative", "where": "app"})[1], "That folder is not on this Mac.")
        self.assertEqual(read({"folder": folder + "\u0015", "where": "app"})[1], "That folder is not on this Mac.")
        self.assertEqual(read({"folder": folder, "where": "vscode"}), (None, "Pick the Claude app or the Terminal."))
        self.assertTrue(read({"folder": folder, "where": "terminal", "prompt": 5})[1].startswith("The first message is too long"))
        self.assertTrue(read({"folder": folder, "where": "terminal", "prompt": "x" * (serve.START_PROMPT_MAX + 1)})[1].startswith("The first message is too long"))
        self.assertEqual(read({"folder": 7, "where": "app"})[1], "That folder is not on this Mac.")
        # a key press the Terminal would act on (Ctrl-U clears the line, a tab completes, Esc starts a sequence)
        for sneaky in ("x\u0015touch ~/p\nrest", "tab\there", "colour \u001b[31m", "cr\r"):
            self.assertIsNone(read({"folder": folder, "where": "terminal", "prompt": sneaky})[0], repr(sneaky))
        self.assertEqual(serve.read_start_request(b"nope"), (None, "That request could not be read."))

    def test_the_app_opens_its_own_link_and_the_terminal_gets_the_folder_and_prompt_as_arguments(self):
        self.assertEqual(serve.start_command("/Users/me/My Dir", "app", ""), ["open", "claude://code/new?folder=%2FUsers%2Fme%2FMy%20Dir"])
        # the first message rides in the link, every character of it encoded, so it can add no part of its own
        self.assertEqual(serve.start_command("/x", "app", "Fix it & then\nq=evil #1"), ["open", "claude://code/new?folder=%2Fx&q=Fix%20it%20%26%20then%0Aq%3Devil%20%231"])
        for app in ("terminal", "iterm"):
            command = serve.start_command("/Users/me/x; rm -rf ~", "terminal", 'hi "you" $(id)', app)
            self.assertEqual(command[0:2], ["osascript", "-e"])
            self.assertNotIn("rm -rf", command[2])
            # the folder and the prompt are quoted for the shell, so they are only words there;
            # a prompt that looks like an option is still the prompt
            self.assertEqual(command[3:], ["--", "cd '/Users/me/x; rm -rf ~' && claude -- 'hi \"you\" $(id)'"])
        self.assertIn('tell application "iTerm"', serve.start_command("/x", "terminal", "", "iterm")[2])
        self.assertIn('tell application "Terminal"', serve.start_command("/x", "terminal", "", "terminal")[2])
        self.assertEqual(serve.start_command("/x", "terminal", "")[3:], ["--", "cd /x && claude"])
        self.assertEqual(serve.start_command("/x", "terminal", "hi", "terminal", "auto")[3:], ["--", "cd /x && claude --permission-mode auto -- hi"])

    def test_starting_says_what_went_wrong(self):
        class Done:
            def __init__(self, code, out="", err=""):
                self.returncode, self.stdout, self.stderr = code, out, err
        self.assertEqual(serve.start_session("/x", "app", "", run=lambda *a, **k: Done(0)), "")
        self.assertEqual(serve.start_session("/x", "app", "", run=lambda *a, **k: Done(1, err="no app")), "Could not start it. no app")

        def broken(*a, **k):
            raise OSError("gone")
        self.assertEqual(serve.start_session("/x", "app", "", run=broken), "Could not start it.")
        folder = str(self.home / "shop")
        self.assertEqual(serve.pick_folder(run=lambda *a, **k: Done(0, out=folder + "/\n")), (folder, ""))
        self.assertEqual(serve.pick_folder(run=lambda *a, **k: Done(0, out="/\n")), ("/", ""))
        self.assertEqual(serve.pick_folder(run=lambda *a, **k: Done(1, err="User canceled.")), (None, "cancelled"))
        self.assertEqual(serve.pick_folder(run=lambda *a, **k: Done(0, out="/no/such/\n")), (None, "cancelled"))
        self.assertEqual(serve.pick_folder(run=lambda *a, **k: Done(0, out="")), (None, "cancelled"))

    def test_only_one_folder_window_is_up_at_a_time(self):
        serve.PICKING.acquire()
        try:
            self.assertEqual(serve.pick_folder(run=lambda *a, **k: self.fail("a second window opened")), (None, "busy"))
        finally:
            serve.PICKING.release()


class PictureTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    @staticmethod
    def image(data=PNG, media="image/png"):
        return {"type": "image", "source": {"type": "base64", "media_type": media, "data": base64.b64encode(data).decode()}}

    def test_each_image_gets_a_ref_to_its_line_and_number(self):
        own = {"type": "user", "message": {"content": [{"type": "text", "text": "titta"}, self.image()]}}
        seen = {"type": "user", "message": {"content": [{"type": "tool_result", "content": [{"type": "text", "text": "x"}, self.image(), self.image(media="image/svg+xml")]}]}}
        lines = [json.dumps(own), json.dumps(seen)]
        items = serve.conversation(lines, [0, 500])
        self.assertEqual(items, [
            {"kind": "you", "text": "titta", "images": 1, "at": None, "pictures": ["0:0"]},
            {"kind": "image", "pictures": ["500:0"], "at": None},
        ])
        self.assertEqual(serve.conversation(lines)[1:], [])

    def test_an_image_is_read_back_from_its_line(self):
        path = self.root / "s.jsonl"
        first = json.dumps({"type": "user", "message": {"content": "hi"}}) + "\n"
        second = json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "content": [self.image()]}]}}) + "\n"
        path.write_text(first + second)
        offset = len(first.encode())
        self.assertEqual(serve.read_picture(path, f"{offset}:0"), ("image/png", PNG))
        for bad in [f"{offset}:1", "0:0", "abc", "", f"{offset}", "99999999:0", "-1:0", "1:2:3"]:
            self.assertIsNone(serve.read_picture(path, bad), bad)
        self.assertEqual(serve.read_chat(path)[-1]["pictures"], [f"{offset}:0"])

    def test_a_fake_image_is_never_handed_out(self):
        path = self.root / "s.jsonl"
        path.write_text(json.dumps({"type": "user", "message": {"content": [self.image(data=b"<script>")]}}) + "\n")
        self.assertIsNone(serve.read_picture(path, "0:0"))

    def test_an_image_sent_from_ccc_is_read_from_the_uploads_only(self):
        folder = self.root / "uploads" / "s1"
        folder.mkdir(parents=True)
        (folder / "1000-ab-1.png").write_bytes(PNG)
        (folder / "1000-ab-2.png").write_bytes(b"not an image")
        uploads = self.root / "uploads"
        self.assertEqual(serve.read_upload(uploads, "s1", "1000-ab-1.png"), ("image/png", PNG))
        for session, name in [("s1", "1000-ab-2.png"), ("s1", "../../etc/passwd"), ("../s1", "1000-ab-1.png"), ("s1", "1000-ab-1.svg"), ("s1", "missing-aa-1.png"), ("s1", "")]:
            self.assertIsNone(serve.read_upload(uploads, session, name), (session, name))


class ChatFromEndTest(unittest.TestCase):
    """The chat is read back from the end of the transcript until it has its items, however many
    bytes of screenshots lie between them."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "s.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, lines) -> list:
        """Writes the lines as a transcript and gives each line's offset."""
        self.path.write_bytes("".join(line + "\n" for line in lines).encode())
        offsets, at = [], 0
        for line in lines:
            offsets.append(at)
            at += len(line.encode()) + 1
        return offsets

    @staticmethod
    def screenshot(number):
        """A step's screenshot line and its image: its own for each number, and longer than a chunk."""
        data = PNG + f"bild {number:04d} ".encode() * 2000
        line = json.dumps({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": f"toolu_s{number}", "content": [PictureTest.image(data)]}]}})
        return line, data

    def test_lines_are_read_back_last_first_at_their_place(self):
        for content in [b'{"a": 1}\n' + b"x" * 50 + b"\n\n" + "naïve café".encode() + b"\nhalf a li", b"one\ntwo\n", b""]:
            self.path.write_bytes(content)
            expected, at = [], 0
            for line in content.split(b"\n"):
                expected.append((at, line))
                at += len(line) + 1
            for chunk in (1, 3, 7, 64, serve.CHAT_CHUNK_BYTES):
                self.assertEqual(list(serve.lines_from_end(self.path, chunk)), expected[::-1], (content, chunk))
        self.assertEqual(list(serve.lines_from_end(self.path.with_name("missing.jsonl"))), [])

    def test_a_line_longer_than_the_limit_is_passed_over(self):
        self.path.write_bytes(b"y" * 100 + b"\nshort\n" + b"z" * 20 + b"\n" + b"y" * 100 + b"\nend")
        self.assertEqual(list(serve.lines_from_end(self.path, 8, longest=20)), [(229, b"end"), (107, b"z" * 20), (101, b"short")])

    def test_images_and_signatures_are_left_out_of_what_the_chat_holds(self):
        payload = base64.b64encode(PNG + b"\x00" * 2000).decode()
        record = {"type": "assistant", "message": {"content": [
            {"type": "thinking", "thinking": "hmm", "signature": payload},
            {"type": "text", "text": f'I wrote "data": "{payload}" in the text.'},
            {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"data": "short"}},
        ]}, "toolUseResult": {"file": {"base64": payload}}}
        for line in (json.dumps(record), json.dumps(record, separators=(",", ":"))):
            slim = json.loads(serve.PAYLOAD.sub(rb'\1"', line.encode()))
            self.assertEqual(slim["message"]["content"][0]["signature"], "")
            self.assertEqual(slim["message"]["content"][1:], record["message"]["content"][1:])
            self.assertEqual(slim["toolUseResult"], {"file": {"base64": ""}})
        own = json.dumps({"type": "user", "message": {"content": [{"type": "text", "text": "titta"}, PictureTest.image(PNG + b"\x00" * 2000)]}})
        slim = serve.PAYLOAD.sub(rb'\1"', own.encode()).decode()
        self.assertLess(len(slim), 200)
        self.assertEqual(serve.conversation([slim], [7]), serve.conversation([own], [7]))

    def test_a_session_full_of_screenshots_shows_its_last_items(self):
        lines, prompts = [], serve.CHAT_ITEMS // 2 + 10
        for number in range(prompts):
            lines.append(json.dumps({"type": "user", "message": {"content": f"Question {number}"}}))
            lines.append(json.dumps({"type": "api-request", "body": "x" * 3000}))
            lines.append(self.screenshot(number)[0])
        offsets = self.write(lines)
        self.assertGreater(self.path.stat().st_size - offsets[3 * 10], 3 * 1024 * 1024)
        items = serve.read_chat(self.path, chunk=4096)
        self.assertEqual(len(items), serve.CHAT_ITEMS)
        self.assertEqual(items, serve.conversation(lines, offsets)[-serve.CHAT_ITEMS:])
        self.assertEqual(items[0]["text"], "Question 10")
        for number, item in ((10, items[1]), (prompts - 1, items[-1])):
            [ref] = item["pictures"]
            self.assertEqual(ref, f"{offsets[3 * number + 2]}:0")
            self.assertEqual(serve.read_picture(self.path, ref), ("image/png", self.screenshot(number)[1]))

    def test_a_question_box_long_before_still_shows_with_its_answer(self):
        ask = {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "toolu_q1", "name": "AskUserQuestion", "input": {"questions": [{"question": "Which way?", "options": [{"label": "A"}, {"label": "B"}]}]}}]}}
        answer = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_q1", "content": "The user answered"}]}, "toolUseResult": {"answers": {"Which way?": "B"}}}
        self.write([json.dumps(ask), json.dumps(answer)] + [self.screenshot(number)[0] for number in range(serve.CHAT_ITEMS - 1)])
        items = serve.read_chat(self.path, chunk=4096)
        self.assertEqual(len(items), serve.CHAT_ITEMS)
        self.assertEqual((items[0]["kind"], items[0]["answers"]), ("question", ["B"]))


class StepTest(unittest.TestCase):
    def test_a_step_is_read_with_what_it_was_given_and_what_came_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "s.jsonl"
            records = [
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "Let me check."}, {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "git status", "description": "See the tree", "timeout": 5}}]}},
                {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": [{"type": "text", "text": "On branch main"}, {"type": "image", "source": {}}]}]}},
                {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "toolu_2", "name": "Read", "input": {"file_path": "/a/b.js"}}]}},
            ]
            path.write_text("\n".join(json.dumps(r) for r in records) + "\n")
            self.assertEqual(serve.read_step(path, "toolu_1"), {
                "name": "Bash",
                "input": 'git status\ndescription: See the tree\n{\n  "timeout": 5\n}',
                "result": "On branch main\n[an image]",
                "isError": False,
                "isDone": True,
            })
            self.assertEqual(serve.read_step(path, "toolu_2"), {"name": "Read", "input": "file_path: /a/b.js", "result": "", "isError": False, "isDone": False, "filePath": "/a/b.js", "fileLine": 1})
            for bad in ["toolu_9", "", "../x", "a b", None]:
                self.assertIsNone(serve.read_step(path, bad), bad)
            self.assertEqual(serve.conversation([json.dumps(records[0])])[1], {"kind": "tool", "text": "$ git status", "at": None, "tool": "Bash", "toolId": "toolu_1"})

    def test_an_error_and_a_plain_text_result_read_as_they_are(self):
        self.assertEqual(serve.shown_result({"content": "boom", "is_error": True}), "boom")
        self.assertEqual(serve.shown_result(None), "")
        self.assertEqual(serve.shown_input("not a dict"), "")


class SendTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.inbox = serve.Inbox(root / "inbox", root / "uploads")

    def tearDown(self):
        self.tmp.cleanup()

    @staticmethod
    def body(**fields):
        return json.dumps({"sessionId": "s1", "text": "hi", **fields}).encode()

    def test_a_plain_message_with_real_images_is_taken(self):
        picture = {"mediaType": "image/png", "data": base64.b64encode(PNG).decode()}
        self.assertEqual(serve.read_send_request(self.body(text="  hi  ", images=[picture])), (("s1", "hi", [("png", PNG)], "queue", []), ""))
        self.assertEqual(serve.read_send_request(self.body(text="", images=[picture]))[0][1], "")

    def test_a_long_message_goes_and_one_too_long_says_so(self):
        long = "line\n" * 100_000
        request, problem = serve.read_send_request(self.body(text=long))
        self.assertEqual((request[1], problem), (long.strip(), ""))
        request, problem = serve.read_send_request(self.body(text="x" * (serve.MESSAGE_TEXT_MAX + 1)))
        self.assertIsNone(request)
        self.assertEqual(problem, "The message is too long: 4 000 001 characters, at most 4 000 000.")
        self.assertGreater(serve.MAX_SEND_BODY_BYTES, serve.MESSAGE_TEXT_MAX * 6)

    def test_a_long_message_shows_its_start_and_what_is_left_out(self):
        self.assertEqual(serve.shown_text("short"), "short")
        shown = serve.shown_text("x" * (serve.CHAT_TEXT_MAX + 1234))
        self.assertTrue(shown.startswith("x" * serve.CHAT_TEXT_MAX))
        self.assertTrue(shown.endswith("… 1 234 more characters, not shown here"))

    def test_a_message_says_whether_it_waits_or_stops_claude(self):
        self.assertEqual(serve.read_send_request(self.body(mode="now"))[0][3], "now")
        self.assertEqual(serve.read_send_request(self.body(mode="queue"))[0][3], "queue")
        self.assertEqual(serve.read_send_request(self.body())[0][3], "queue")
        self.assertIsNone(serve.read_send_request(self.body(mode="later"))[0])

    def test_anything_odd_is_refused(self):
        fake = {"mediaType": "image/png", "data": base64.b64encode(b"not a picture").decode()}
        svg = {"mediaType": "image/svg+xml", "data": base64.b64encode(b"<svg/>").decode()}
        for body in [
            b"not json", b"[]", self.body(sessionId="../etc"), self.body(text=""), self.body(text="x" * (serve.MESSAGE_TEXT_MAX + 1)),
            self.body(images=[fake]), self.body(images=[svg]), self.body(images=[{"mediaType": "image/png", "data": "@@@"}]),
            self.body(images=[{"mediaType": "image/png", "data": base64.b64encode(PNG).decode()}] * (serve.MAX_IMAGES + 1)),
            self.body(images="no"), self.body(text=5), self.body(mode=1),
        ]:
            request, problem = serve.read_send_request(body)
            self.assertIsNone(request, body[:60])
            self.assertTrue(problem, body[:60])

    def test_a_sent_message_waits_until_the_session_takes_it(self):
        message_id = self.inbox.send("s1", "hi", [("png", PNG)], "now", 1000)
        folder = Path(self.tmp.name) / "inbox" / "s1"
        stored = json.loads((folder / f"{message_id}.json").read_text())
        self.assertEqual((stored["text"], stored["mode"]), ("hi", "now"))
        self.assertEqual(Path(stored["images"][0]).read_bytes(), PNG)
        self.assertEqual(self.inbox.pending("s1"), [{"id": message_id, "text": "hi", "images": 1, "files": 0, "mode": "now", "at": 1000}])
        (folder / f"{message_id}.taken").write_text("1")
        self.assertEqual(self.inbox.pending("s1"), [])
        self.assertEqual(list(folder.iterdir()), [])
        self.assertEqual(self.inbox.pending("../x"), [])

    def test_any_dropped_file_goes_along_under_its_own_name(self):
        notes = {"name": "../../etc/My notes (v2).txt", "data": base64.b64encode(b"hello").decode()}
        request, problem = serve.read_send_request(self.body(files=[notes]))
        self.assertEqual((request[4], problem), ([("My notes (v2).txt", b"hello")], ""))
        self.assertEqual(serve.safe_file_name("a/b/crème brûlée?.md"), "cr_me br_l_e_.md")
        self.assertEqual(serve.safe_file_name(""), "file")
        message_id = self.inbox.send("s1", "", [], "queue", 1000, request[4])
        stored = json.loads((Path(self.tmp.name) / "inbox" / "s1" / f"{message_id}.json").read_text())
        self.assertTrue(stored["files"][0].endswith(f"{message_id}-f1-My notes (v2).txt"))
        self.assertEqual(Path(stored["files"][0]).read_bytes(), b"hello")
        self.assertEqual(self.inbox.pending("s1")[0]["files"], 1)
        too_many = self.body(files=[notes] * (serve.MAX_FILES + 1))
        self.assertIsNone(serve.read_send_request(too_many)[0])
        self.assertIsNone(serve.read_send_request(self.body(files=[{"name": "x", "data": "@@@"}]))[0])

    def test_a_sessions_slash_commands_are_read_plainly(self):
        folder = Path(self.tmp.name) / "commands"
        folder.mkdir()
        (folder / "s1.json").write_text(json.dumps({"commands": [{"name": "caveman", "description": "Talk less", "source": "plugin"}, {"name": "../bad"}, "x"], "models": ["opus", "opus[1m]", "<b>"]}))
        self.assertEqual(serve.read_commands(folder, "s1"), {"commands": [{"name": "caveman", "description": "Talk less", "source": "plugin"}], "models": ["opus", "opus[1m]"]})
        self.assertEqual(serve.read_commands(folder, "s2"), {"commands": [], "models": []})
        self.assertEqual(serve.read_commands(folder, "../s1"), {"commands": [], "models": []})

    def test_a_step_says_its_tool_and_a_browser_batch_its_actions(self):
        self.assertEqual(serve.tool_facts("Bash", {"command": "ls"}), {"tool": "Bash"})
        batch = {"actions": [{"name": "javascript_tool", "input": {"action": "javascript_exec"}}, {"name": "computer", "input": {"action": "screenshot"}}, {"name": "navigate", "input": {}}, "x"]}
        self.assertEqual(serve.tool_facts("mcp__Claude_Browser__browser_batch", batch)["actions"], ["javascript_tool:javascript_exec", "computer:screenshot", "navigate"])
        self.assertEqual(serve.tool_facts(None, {}), {})

    def test_the_chat_shows_a_sent_file_by_its_own_name(self):
        prompt = "Look\n\nFiles I added (open them with the Read tool):\n- /u/s1/1000-ab12-f1-notes.txt\n\nImages I added (open them with the Read tool):\n- /u/s1/1000-ab12-1.png"
        [item] = serve.user_items(prompt, 5)
        self.assertEqual((item["text"], item["files"], item["images"]), ("Look", ["notes.txt"], 1))

    def test_send_now_makes_a_waiting_message_go_in_at_once(self):
        message_id = self.inbox.send("s1", "hi", [], "queue", 1000)
        self.assertTrue(self.inbox.hurry("s1", message_id, 5000))
        stored = json.loads((Path(self.tmp.name) / "inbox" / "s1" / f"{message_id}.json").read_text())
        self.assertEqual((stored["mode"], stored["at"], stored["text"]), ("now", 5000, "hi"))
        (Path(self.tmp.name) / "inbox" / "s1" / f"{message_id}.taken").write_text("1")
        self.assertFalse(self.inbox.hurry("s1", message_id, 6000))
        self.assertFalse(self.inbox.hurry("s1", "1-ab", 6000))
        self.assertFalse(self.inbox.hurry("../s1", message_id, 6000))

    def test_taken_messages_are_cleared_when_the_next_one_is_sent(self):
        first = self.inbox.send("s1", "x" * 1000, [], "queue", 1000)
        folder = Path(self.tmp.name) / "inbox" / "s1"
        (folder / f"{first}.taken").write_text("1")
        second = self.inbox.send("s1", "hi", [], "queue", 2000)
        self.assertEqual(sorted(p.name for p in folder.iterdir()), [f"{second}.json"])

    def test_a_stop_is_left_for_the_session_and_never_shown_as_waiting(self):
        message_id = self.inbox.stop("s1", 2000)
        stored = json.loads((Path(self.tmp.name) / "inbox" / "s1" / f"{message_id}.json").read_text())
        self.assertEqual(stored, {"id": message_id, "stop": True, "at": 2000})
        self.assertEqual(self.inbox.pending("s1"), [])
        self.assertTrue(serve.is_from_board({"X-CCC-Action": "interrupt", "Origin": "http://127.0.0.1:8765"}, 8765, "interrupt"))
        self.assertFalse(serve.is_from_board({"X-CCC-Action": "send"}, 8765, "interrupt"))

    def test_sending_needs_its_own_header(self):
        port = 8765
        self.assertTrue(serve.is_from_board({"X-CCC-Action": "send", "Origin": f"http://127.0.0.1:{port}"}, port, "send"))
        self.assertFalse(serve.is_from_board({"X-CCC-Action": "notes"}, port, "send"))
        self.assertFalse(serve.is_from_board({"X-CCC-Action": "send", "Origin": "https://evil.example"}, port, "send"))


class RemovalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.removals = serve.Removals(Path(self.tmp.name) / "ccc" / "removed.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_removed_session_is_hidden_but_still_counts_for_today(self):
        self.removals.remove("s1", 1000)
        sessions = [{"sessionId": "s1", "turn": {"startedAt": 900}, "today": {"day": "D", "usd": 2}}, {"sessionId": "s2"}]
        shown, hidden, back = serve.split_removed(sessions, self.removals.load())
        self.assertEqual([s["sessionId"] for s in shown], ["s2"])
        self.assertEqual(hidden, [{"sessionId": "s1", "today": {"day": "D", "usd": 2}}])
        self.assertEqual(back, [])

    def test_it_comes_back_when_a_new_turn_starts(self):
        self.removals.remove("s1", 1000)
        shown, hidden, back = serve.split_removed([{"sessionId": "s1", "turn": {"startedAt": 1500}}], self.removals.load())
        self.assertEqual([s["sessionId"] for s in shown], ["s1"])
        self.assertEqual((hidden, back), ([], ["s1"]))
        self.removals.forget(back)
        self.assertEqual(self.removals.load(), {})

    def test_it_comes_back_when_the_person_writes_mid_turn(self):
        removed = {"s1": 1000}
        mid_turn = {"sessionId": "s1", "turn": {"isRunning": True, "startedAt": 900}, "lastPromptAt": 1500}
        quiet = {"sessionId": "s1", "turn": {"isRunning": True, "startedAt": 900}, "lastPromptAt": 950}
        self.assertEqual(serve.split_removed([mid_turn], removed)[2], ["s1"])
        self.assertEqual(serve.split_removed([quiet], removed)[2], [])

    def test_the_last_prompt_is_read_from_the_transcript(self):
        lines = [
            {"type": "user", "timestamp": "2026-10-19T14:00:00Z", "message": {"content": "first"}},
            {"type": "attachment", "timestamp": "2026-10-19T14:30:00Z", "attachment": {"type": "queued_command", "prompt": "mitt i"}},
            {"type": "user", "timestamp": "2026-10-19T14:40:00Z", "message": {"content": [{"type": "tool_result", "content": "ok"}]}},
            {"type": "user", "timestamp": "2026-10-19T14:50:00Z", "isMeta": True, "message": {"content": "meta"}},
        ]
        text = "\n".join(json.dumps(line) for line in lines)
        self.assertEqual(serve.last_prompt_at(text), 1792420200000)
        self.assertIsNone(serve.last_prompt_at(json.dumps(lines[2])))
        report = {"type": "user", "timestamp": "2026-10-19T15:00:00Z", "message": {"content": "<task-notification><status>completed</status></task-notification>"}}
        self.assertEqual(serve.last_prompt_at(text + "\n" + json.dumps(report)), 1792420200000)

    def test_the_payload_forgets_sessions_that_came_back(self):
        sessions_dir = Path(self.tmp.name) / "sessions"
        sessions_dir.mkdir()
        (sessions_dir / "s1.json").write_text(json.dumps({"version": 1, "sessionId": "s1", "turn": {"startedAt": 5000}}))
        (sessions_dir / "s2.json").write_text(json.dumps({"version": 1, "sessionId": "s2", "turn": {"startedAt": 10}}))
        self.removals.remove("s1", 1000)
        self.removals.remove("s2", 1000)
        payload = serve.board_payload(sessions_dir, self.removals, serve.Transcripts(Path(self.tmp.name) / "none"), prompts_dir=Path(self.tmp.name) / "prompts", approvals_dir=Path(self.tmp.name) / "approvals")
        self.assertEqual([s["sessionId"] for s in payload["sessions"]], ["s1"])
        self.assertEqual([h["sessionId"] for h in payload["hidden"]], ["s2"])
        self.assertEqual(list(self.removals.load()), ["s2"])

    def test_a_broken_removals_file_counts_as_none(self):
        self.removals.path.parent.mkdir(parents=True)
        self.removals.path.write_text("{oops")
        self.assertEqual(self.removals.load(), {})
        self.removals.path.write_text(json.dumps({"removed": {"ok": 5, "../x": 6, "bad": "y"}}))
        self.assertEqual(self.removals.load(), {"ok": 5})

    def test_only_a_plain_request_names_a_session(self):
        self.assertEqual(serve.removal_target(b'{"sessionId": "s1-ab"}'), "s1-ab")
        for body in (b'{"sessionId": "../etc"}', b"[1]", b"nope", b"\xff", b'{"sessionId": 7}'):
            self.assertIsNone(serve.removal_target(body))

    def test_only_the_board_page_may_remove(self):
        ok = {"X-CCC-Action": "remove", "Origin": "http://127.0.0.1:8765"}
        self.assertTrue(serve.is_from_board(ok, 8765))
        self.assertTrue(serve.is_from_board({"X-CCC-Action": "remove"}, 8765))
        self.assertFalse(serve.is_from_board({"Origin": "http://127.0.0.1:8765"}, 8765))
        self.assertFalse(serve.is_from_board({"X-CCC-Action": "remove", "Origin": "https://evil.example"}, 8765))



class NotesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.notes = serve.Notes(Path(self.tmp.name) / "ccc" / "notes.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_notes_are_saved_and_read_back_as_written(self):
        text = "- merge ABC-1234\n- reply to Sam\n\n  indented and ÅÄÖ"
        self.notes.save(serve.clean_notes({"text": text}))
        self.assertEqual(self.notes.load(), text)

    def test_odd_input_becomes_empty_and_long_text_is_cut(self):
        self.assertEqual(serve.clean_notes({"text": 7}), "")
        self.assertEqual(serve.clean_notes("nope"), "")
        self.assertEqual(len(serve.clean_notes({"text": "x" * 30_000})), serve.MAX_NOTES_TEXT)

    def test_a_missing_or_broken_file_is_empty_notes(self):
        self.assertEqual(self.notes.load(), "")
        self.notes.path.parent.mkdir(parents=True)
        self.notes.path.write_text("{oops")
        self.assertEqual(self.notes.load(), "")

    def test_saving_notes_needs_its_own_header(self):
        self.assertTrue(serve.is_from_board({"X-CCC-Action": "notes"}, 8765, "notes"))
        self.assertFalse(serve.is_from_board({"X-CCC-Action": "remove"}, 8765, "notes"))


class ShownApprovalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name) / "prompts"

    def tearDown(self):
        self.tmp.cleanup()

    def session(self, waiting, session_id="s1"):
        return {"sessionId": session_id, "turn": {"isRunning": True, "waiting": waiting}}

    def test_a_notice_after_the_approval_began_marks_its_box_as_shown(self):
        prompt_seen.note(self.dir, "s1", 2000)
        marked = serve.with_shown_approvals([self.session({"kind": "approval", "since": 1000, "text": "Artifact"})], self.dir)
        self.assertEqual(marked[0]["turn"]["waiting"], {"kind": "approval", "since": 1000, "text": "Artifact", "isShown": True})
        self.assertTrue(marked[0]["turn"]["isRunning"])

    def test_a_notice_from_an_earlier_box_or_none_leaves_it_unmarked(self):
        prompt_seen.note(self.dir, "s1", 500)
        approval = self.session({"kind": "approval", "since": 1000})
        self.assertEqual(serve.with_shown_approvals([approval], self.dir), [approval])
        other = self.session({"kind": "approval", "since": 1000}, "s2")
        self.assertEqual(serve.with_shown_approvals([other], self.dir), [other])

    def test_only_approvals_are_marked(self):
        prompt_seen.note(self.dir, "s1", 2000)
        question = self.session({"kind": "question", "since": 1000})
        idle = {"sessionId": "s1", "turn": {"isRunning": False}}
        self.assertEqual(serve.with_shown_approvals([question, idle, {"sessionId": "s1"}], self.dir), [question, idle, {"sessionId": "s1"}])

    def test_a_broken_or_odd_notice_file_counts_as_none(self):
        self.dir.mkdir(parents=True)
        for text in ("{oops", "[1]", '{"at": "soon"}', '{"at": true}'):
            (self.dir / "s1.json").write_text(text)
            self.assertIsNone(serve.prompt_seen_at(self.dir, "s1"))
        self.assertIsNone(serve.prompt_seen_at(self.dir, "../s1"))
        self.assertIsNone(serve.prompt_seen_at(self.dir, None))

    def test_the_payload_marks_shown_approvals(self):
        sessions_dir = Path(self.tmp.name) / "sessions"
        sessions_dir.mkdir()
        snapshot = {"version": 1, "sessionId": "s1", "turn": {"startedAt": 10, "isRunning": True, "waiting": {"kind": "approval", "since": 1000}}}
        (sessions_dir / "s1.json").write_text(json.dumps(snapshot))
        prompt_seen.note(self.dir, "s1", 7000)
        removals = serve.Removals(Path(self.tmp.name) / "removed.json")
        payload = serve.board_payload(sessions_dir, removals, serve.Transcripts(Path(self.tmp.name) / "none"), prompts_dir=self.dir, approvals_dir=self.dir)
        self.assertTrue(payload["sessions"][0]["turn"]["waiting"]["isShown"])


class PromptSeenHookTest(unittest.TestCase):
    NOTICE = {"session_id": "s1-ab", "notification_type": "permission_prompt", "message": "Claude needs your permission to use Artifact"}

    def test_only_a_main_thread_permission_prompt_counts(self):
        self.assertEqual(prompt_seen.seen_prompt(self.NOTICE), "s1-ab")
        self.assertIsNone(prompt_seen.seen_prompt({**self.NOTICE, "notification_type": "idle_prompt"}))
        self.assertIsNone(prompt_seen.seen_prompt({**self.NOTICE, "agent_id": "a1"}))
        self.assertIsNone(prompt_seen.seen_prompt({**self.NOTICE, "session_id": "../etc"}))
        self.assertIsNone(prompt_seen.seen_prompt({**self.NOTICE, "session_id": 7}))
        self.assertIsNone(prompt_seen.seen_prompt(None))
        self.assertIsNone(prompt_seen.seen_prompt([1]))

    def test_the_hook_leaves_the_time_and_never_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {**os.environ, "CCC_PROMPTS_DIR": str(Path(tmp) / "prompts")}
            script = str(Path(__file__).resolve().parent / "prompt_seen.py")
            for given in (json.dumps(self.NOTICE), "not json", ""):
                done = subprocess.run(["/usr/bin/python3", script], input=given, text=True, env=env, capture_output=True, timeout=20)
                self.assertEqual((done.returncode, done.stdout, done.stderr), (0, "", ""))
            at = json.loads((Path(tmp) / "prompts" / "s1-ab.json").read_text())["at"]
            self.assertAlmostEqual(at, time.time() * 1000, delta=60_000)
            self.assertEqual(sorted(p.name for p in (Path(tmp) / "prompts").iterdir()), ["s1-ab.json"])


def reply_line(key, stamp, given=0, written=0, cached=0, made=0, kind="assistant"):
    usage = {"input_tokens": given, "output_tokens": written, "cache_read_input_tokens": cached, "cache_creation_input_tokens": made}
    return json.dumps({"type": kind, "timestamp": stamp, "message": {"id": key, "role": "assistant", "usage": usage}})


def local_stamp(when):
    """A local time written the way transcripts write times: UTC with a Z."""
    return datetime.fromtimestamp(when.timestamp(), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


class TokenTest(unittest.TestCase):
    NOW = datetime(2026, 10, 20, 14, 30).timestamp()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.file = self.dir / "-Users-me-repo" / "s1.jsonl"
        self.file.parent.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def append(self, *lines, end="\n"):
        with self.file.open("a") as handle:
            handle.write("\n".join(lines) + end)

    def ledger(self):
        return serve.UsageLedger(self.dir, refresh_s=0)

    def test_a_reply_counts_new_input_output_and_cached_text(self):
        key, used = serve.usage_of(reply_line("m1", "2026-10-20T12:00:00Z", given=3, written=40, cached=900, made=200).encode())
        self.assertEqual((key, used[1:]), ("m1", (203, 40, 900)))
        self.assertEqual(used[0], datetime(2026, 10, 20, 12, tzinfo=timezone.utc).timestamp())
        for line in (reply_line("m1", "2026-10-20T12:00:00Z", kind="user"), '{"type": "assistant"}', "nope", "[1]",
                     json.dumps({"type": "assistant", "timestamp": "2026-10-20T12:00:00Z", "message": {"usage": {}}})):
            self.assertIsNone(serve.usage_of(line.encode()))

    def test_odd_counts_count_as_nothing(self):
        usage = {"input_tokens": "9", "output_tokens": True, "cache_read_input_tokens": -4}
        line = json.dumps({"type": "assistant", "timestamp": "2026-10-20T12:00:00Z", "message": {"id": "m", "usage": usage}})
        self.assertEqual(serve.usage_of(line.encode())[1][1:], (0, 0, 0))

    def test_today_and_yesterday_are_split_by_local_midnight_and_hour(self):
        today = datetime(2026, 10, 20, 9, 15)
        late = datetime(2026, 10, 19, 23, 59)
        old = datetime(2026, 10, 18, 12, 0)
        self.append(
            reply_line("a", local_stamp(today), given=10, written=5, cached=100),
            reply_line("b", local_stamp(late), written=7),
            reply_line("c", local_stamp(old), written=1000),
        )
        summary = self.ledger().summary(self.NOW)
        self.assertEqual(summary["today"], {"input": 10, "output": 5, "cached": 100, "total": 115})
        self.assertEqual(summary["yesterday"], {"input": 0, "output": 7, "cached": 0, "total": 7})
        self.assertEqual(summary["hours"]["today"][9], 115)
        self.assertEqual(summary["hours"]["yesterday"][23], 7)
        self.assertEqual(summary["hour"], 14)

    def test_a_reply_written_as_several_lines_counts_once(self):
        stamp = local_stamp(datetime(2026, 10, 20, 10, 0))
        self.append(reply_line("m1", stamp, written=3, cached=50), reply_line("m1", stamp, written=80, cached=50), reply_line("m2", stamp, written=1))
        self.assertEqual(self.ledger().summary(self.NOW)["today"]["output"], 81)

    def test_only_what_is_added_is_read_and_half_a_line_waits(self):
        ledger = self.ledger()
        stamp = local_stamp(datetime(2026, 10, 20, 10, 0))
        self.append(reply_line("m1", stamp, written=10))
        self.assertEqual(ledger.summary(self.NOW)["today"]["output"], 10)
        half = reply_line("m2", stamp, written=5)
        self.append(half[:20], end="")
        self.assertEqual(ledger.summary(self.NOW)["today"]["output"], 10)
        self.append(half[20:])
        self.assertEqual(ledger.summary(self.NOW)["today"]["output"], 15)
        self.assertEqual(ledger.offsets[self.file], self.file.stat().st_size)

    def test_a_file_that_shrank_is_read_again(self):
        ledger = self.ledger()
        stamp = local_stamp(datetime(2026, 10, 20, 10, 0))
        self.append(reply_line("m1", stamp, written=10), reply_line("m2", stamp, written=10))
        ledger.summary(self.NOW)
        self.file.write_text(reply_line("m3", stamp, written=4) + "\n")
        self.assertEqual(ledger.summary(self.NOW)["today"]["output"], 24)

    def test_subagent_transcripts_count_and_old_files_are_skipped(self):
        stamp = local_stamp(datetime(2026, 10, 20, 10, 0))
        agent = self.dir / "-Users-me-repo" / "s1" / "subagents" / "agent-a1.jsonl"
        agent.parent.mkdir(parents=True)
        agent.write_text(reply_line("sub", stamp, written=6) + "\n")
        stale = self.dir / "-Users-me-repo" / "s0.jsonl"
        stale.write_text(reply_line("old", stamp, written=99) + "\n")
        long_ago = self.NOW - (serve.TOKEN_HISTORY_DAYS + 30) * 86400
        os.utime(stale, (long_ago, long_ago))
        self.assertEqual(self.ledger().summary(self.NOW)["today"]["output"], 6)

    def test_the_ledger_rereads_only_after_its_refresh_time(self):
        ledger = serve.UsageLedger(self.dir, refresh_s=10)
        stamp = local_stamp(datetime(2026, 10, 20, 10, 0))
        self.append(reply_line("m1", stamp, written=1))
        ledger.summary(self.NOW)
        self.append(reply_line("m2", stamp, written=1))
        self.assertEqual(ledger.summary(self.NOW + 5)["today"]["output"], 1)
        self.assertEqual(ledger.summary(self.NOW + 10)["today"]["output"], 2)

    def test_history_sums_each_day_and_today_by_hour(self):
        self.append(
            reply_line("a", local_stamp(datetime(2026, 10, 20, 9, 0)), given=1, written=2, cached=3),
            reply_line("b", local_stamp(datetime(2026, 10, 18, 22, 0)), written=10),
            reply_line("c", local_stamp(datetime(2026, 9, 1, 12, 0)), written=99),
        )
        history = self.ledger().history(self.NOW, 3)
        self.assertEqual([d["day"] for d in history["days"]], ["2026-10-18", "2026-10-19", "2026-10-20"])
        self.assertEqual([d["total"] for d in history["days"]], [10, 0, 6])
        self.assertEqual(history["days"][2], {"day": "2026-10-20", "input": 1, "output": 2, "cached": 3, "total": 6})
        self.assertEqual(history["hours"][9], {"input": 1, "output": 2, "cached": 3, "total": 6})
        self.assertEqual(sum(h["total"] for h in history["hours"]), 6)
        self.assertEqual(history["hour"], 14)
        self.assertEqual(history["firstDay"], "2026-09-01")

    def test_history_days_stay_within_what_is_kept(self):
        self.assertEqual(len(self.ledger().history(self.NOW, 500)["days"]), serve.TOKEN_HISTORY_DAYS)
        self.assertEqual(len(self.ledger().history(self.NOW, 0)["days"]), 1)
        self.assertIsNone(self.ledger().history(self.NOW, 7)["firstDay"])
        self.assertEqual(serve.history_days("/api/tokens/history?days=30"), 30)
        self.assertEqual(serve.history_days("/api/tokens/history?days=999"), 90)
        for path in ("/api/tokens/history", "/api/tokens/history?days=-3", "/api/tokens/history?days=x"):
            self.assertEqual(serve.history_days(path), 7)

    def prompt_line(self, text, when, kind="user", **extra):
        stamp = local_stamp(when)
        if kind == "user":
            record = {"type": "user", "uuid": f"u-{text[:8]}-{when.minute}", "sessionId": "s1", "timestamp": stamp, "message": {"role": "user", "content": text}, **extra}
        else:
            record = {"type": "attachment", "uuid": f"a-{text[:8]}", "sessionId": "s1", "timestamp": stamp, "attachment": {"type": "queued_command", "prompt": text}, **extra}
        return json.dumps(record)

    def test_prompts_today_count_what_the_person_wrote_per_session(self):
        at = datetime(2026, 10, 20, 10, 0)
        result = {"type": "user", "uuid": "r1", "sessionId": "s1", "timestamp": local_stamp(at), "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}}
        image = {"type": "user", "uuid": "i1", "sessionId": "s1", "timestamp": local_stamp(at), "message": {"content": [{"type": "image", "source": {}}]}}
        other = {"type": "user", "uuid": "o1", "sessionId": "s2", "timestamp": local_stamp(at), "message": {"content": [{"type": "text", "text": "hi"}]}}
        self.append(
            self.prompt_line("Build the board", at),
            self.prompt_line("and a bit more", at, kind="attachment"),
            self.prompt_line("<task-notification><status>completed</status></task-notification>", at),
            self.prompt_line("<side-sessions-event>x</side-sessions-event>", at),
            self.prompt_line("[Request interrupted by user]", at),
            self.prompt_line("<system-reminder>just a reminder</system-reminder>", at),
            self.prompt_line("sammanfattning", at, isCompactSummary=True),
            self.prompt_line("meta", at, isMeta=True),
            self.prompt_line("agentens prompt", at, isSidechain=True),
            self.prompt_line("yesterday", datetime(2026, 10, 19, 23, 0)),
            json.dumps(result),
            json.dumps(image),
            json.dumps(other),
        )
        self.assertEqual(self.ledger().summary(self.NOW)["prompts"], {"bySession": {"s1": 3, "s2": 1}, "total": 4})

    def test_a_prompt_copied_into_another_file_counts_once(self):
        line = self.prompt_line("Build the board", datetime(2026, 10, 20, 10, 0))
        self.append(line)
        copy = self.dir / "-Users-me-repo" / "s1-fork.jsonl"
        copy.write_text(line + "\n")
        self.assertEqual(self.ledger().summary(self.NOW)["prompts"]["total"], 1)

    def test_a_prompt_with_an_odd_session_id_is_no_prompt(self):
        record = json.loads(self.prompt_line("hi", datetime(2026, 10, 20, 10, 0)))
        record["sessionId"] = "../x"
        self.assertIsNone(serve.prompt_of(json.dumps(record).encode()))
        self.assertIsNone(serve.prompt_of(b"nope"))

    def test_midnight_is_local(self):
        self.assertEqual(serve.day_start(self.NOW), datetime(2026, 10, 20).timestamp())
        self.assertEqual(serve.day_start(self.NOW, 1), datetime(2026, 10, 19).timestamp())


class ApprovalServerTest(unittest.TestCase):
    BOX = "ab12cd34ef567890"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.approvals = serve.Approvals(self.dir)

    def tearDown(self):
        self.tmp.cleanup()

    def note(self, beat=10_000, **fields):
        note = {"box": self.BOX, "tool": "Bash", "at": 9_000, "beat": beat, "description": "Fetch files", "command": "gh api repos/x\necho done", **fields}
        (self.dir / "s1.box.json").write_text(json.dumps(note))

    def session(self, **turn):
        return {"sessionId": "s1", "turn": {"isRunning": True, **turn}}

    def test_a_box_the_hook_keeps_up_is_read_with_what_it_is_about(self):
        self.note()
        box = serve.approval_box(self.dir, "s1", 12_000)
        self.assertEqual(box, {"box": self.BOX, "tool": "Bash", "at": 9_000, "description": "Fetch files", "command": "gh api repos/x\necho done"})
        self.assertEqual(serve.approval_text(box), "$ gh api repos/x")
        self.assertEqual(serve.approval_text({"tool": "Edit", "target": "/a/b.py"}), "Edit /a/b.py")

    def test_a_box_from_a_hook_that_is_gone_or_a_broken_note_is_no_box(self):
        self.note(beat=1_000)
        self.assertIsNone(serve.approval_box(self.dir, "s1", 1_000 + serve.APPROVAL_BEAT_MS + 1))
        for bad in ({"box": "nope"}, {"tool": ""}, {"tool": 7}, {"at": "x"}, {"beat": True}):
            self.note(**bad)
            self.assertIsNone(serve.approval_box(self.dir, "s1", 10_000), bad)
        (self.dir / "s1.box.json").write_text("{half")
        self.assertIsNone(serve.approval_box(self.dir, "s1", 10_000))
        self.assertIsNone(serve.approval_box(self.dir, "../s1", 10_000))
        self.assertIsNone(serve.approval_box(self.dir, "nobody", 10_000))

    def test_a_running_session_with_a_box_waits_for_approval_shown_with_the_reason_the_mod_gave(self):
        self.note()
        own = {"kind": "approval", "since": 8_000, "text": "$ gh api", "toolUseId": "toolu_1", "reason": "Contains brace with quote character"}
        [marked] = serve.with_approval_boxes([self.session(waiting=own)], self.dir, 12_000)
        waiting = marked["turn"]["waiting"]
        self.assertEqual((waiting["kind"], waiting["since"], waiting["isShown"], waiting["reason"], waiting["toolUseId"]), ("approval", 9_000, True, "Contains brace with quote character", "toolu_1"))
        self.assertEqual(waiting["box"]["box"], self.BOX)
        [bare] = serve.with_approval_boxes([self.session()], self.dir, 12_000)
        self.assertEqual(bare["turn"]["waiting"]["text"], "$ gh api repos/x")
        self.assertNotIn("reason", bare["turn"]["waiting"])

    def test_once_the_box_was_answered_the_session_no_longer_waits_while_the_call_runs(self):
        own = {"kind": "approval", "since": 8_000, "text": "$ gh api", "toolUseId": "toolu_1"}
        (self.dir / "s1.ended.json").write_text(json.dumps({"box": self.BOX, "at": 9_000, "endedAt": 9_500}))
        [answered] = serve.with_approval_boxes([self.session(waiting=own)], self.dir, 12_000)
        self.assertNotIn("waiting", answered["turn"])
        self.assertTrue(answered["turn"]["isRunning"])
        # a box answered before this call asked is about another call
        [later] = serve.with_approval_boxes([self.session(waiting={**own, "since": 9_100})], self.dir, 12_000)
        self.assertEqual(later["turn"]["waiting"]["since"], 9_100)
        question = {"kind": "question", "since": 9_600}
        [asked] = serve.with_approval_boxes([self.session(waiting=question)], self.dir, 12_000)
        self.assertEqual(asked["turn"]["waiting"], question)
        self.assertIsNone(serve.approval_ended_at(self.dir, "nobody"))
        self.assertIsNone(serve.approval_ended_at(self.dir, "../s1"))

    def test_a_box_left_from_a_turn_that_ended_counts_for_nothing(self):
        self.note()
        ended = {"sessionId": "s1", "turn": {"isRunning": False}}
        self.assertEqual(serve.with_approval_boxes([ended], self.dir, 12_000), [ended])
        other = {"sessionId": "s2", "turn": {"isRunning": True}}
        self.assertEqual(serve.with_approval_boxes([other], self.dir, 12_000), [other])

    def test_a_decision_is_a_plain_allow_or_deny_for_one_box(self):
        self.assertEqual(serve.read_approve_request(json.dumps({"sessionId": "s1", "box": self.BOX, "decision": "allow"}).encode()), ("s1", self.BOX, "allow", None, None))
        # the branch question's answer is the branch picked, which only goes with an allow
        self.assertEqual(serve.read_approve_request(json.dumps({"sessionId": "s1", "box": self.BOX, "decision": "allow", "branch": "stay"}).encode()), ("s1", self.BOX, "allow", "stay", None))
        for bad_branch in ({"decision": "allow", "branch": "main"}, {"decision": "deny", "branch": "new"}):
            self.assertIsNone(serve.read_approve_request(json.dumps({"sessionId": "s1", "box": self.BOX, **bad_branch}).encode()), bad_branch)
        for bad in ({"sessionId": "../s1", "box": self.BOX, "decision": "allow"}, {"sessionId": "s1", "box": "toolu_1", "decision": "allow"},
                    {"sessionId": "s1", "box": self.BOX, "decision": "always"}, {"sessionId": "s1", "box": self.BOX}, ["s1"]):
            self.assertIsNone(serve.read_approve_request(json.dumps(bad).encode()), bad)
        self.assertIsNone(serve.read_approve_request(b"nope"))

    def test_the_decision_is_left_for_the_hook_of_that_very_box(self):
        self.note()
        self.assertEqual(self.approvals.give("s1", self.BOX, "deny", 12_000), "")
        left = json.loads((self.dir / "s1.answer.json").read_text())
        self.assertEqual(left, {"box": self.BOX, "decision": "deny", "at": 12_000})
        self.assertEqual(approve_from_ccc.read_decision(self.dir / "s1.answer.json", self.BOX), ("deny", None, None))
        self.assertIsNone(approve_from_ccc.read_decision(self.dir / "s1.answer.json", "ffffffffffffffff"))

    def test_the_branch_question_is_shown_and_answered_with_the_branch_picked(self):
        tool = approve_from_ccc.BRANCH_TOOL
        self.assertEqual(approve_from_ccc.shown(tool, {"suggested": "fix/tax"}), {"kind": "branch", "suggested": "fix/tax"})
        self.note(tool=tool, kind="branch", suggested="fix/tax", command=None, description=None)
        box = serve.approval_box(self.dir, "s1", 12_000)
        self.assertEqual((box["kind"], box["suggested"]), ("branch", "fix/tax"))
        self.assertEqual(self.approvals.give("s1", self.BOX, "allow", 12_000, "new"), "")
        self.assertEqual(approve_from_ccc.read_decision(self.dir / "s1.answer.json", self.BOX), ("allow", "new", None))
        # as the Claude app answers it: the call allowed, the choice in its input
        given = {"suggested": "fix/tax", "_setupAnswer": {"kind": "branch", "choice": "stay"}}
        new = approve_from_ccc.decision("allow", tool, given, "new")["hookSpecificOutput"]["decision"]
        self.assertEqual(new, {"behavior": "allow", "updatedInput": {"suggested": "fix/tax", "_setupAnswer": {"kind": "branch", "choice": "new", "name": "fix/tax"}}})
        stay = approve_from_ccc.decision("allow", tool, given, "stay")["hookSpecificOutput"]["decision"]
        self.assertEqual(stay["updatedInput"]["_setupAnswer"], {"kind": "branch", "choice": "stay"})
        # any other box is never handed a branch
        self.assertEqual(approve_from_ccc.decision("allow", "Bash", {"command": "ls"}, "new")["hookSpecificOutput"]["decision"], {"behavior": "allow"})
        self.note()
        self.assertEqual(self.approvals.give("s1", self.BOX, "allow", 12_000, "new"), "That box does not ask about a branch.")

    def test_words_written_while_a_box_waits_turn_it_down_and_tell_claude_what_to_do(self):
        read = lambda fields: serve.read_approve_request(json.dumps({"sessionId": "s1", "box": self.BOX, **fields}).encode())
        self.assertEqual(read({"decision": "deny", "message": " use main as base "}), ("s1", self.BOX, "deny", None, "use main as base"))
        for bad in ({"decision": "allow", "message": "x"}, {"decision": "deny", "message": "  "}, {"decision": "deny", "message": 5}):
            self.assertIsNone(read(bad), bad)
        self.note()
        self.assertEqual(self.approvals.give("s1", self.BOX, "deny", 12_000, None, "use main as base"), "")
        read_back = approve_from_ccc.read_decision(self.dir / "s1.answer.json", self.BOX)
        self.assertEqual(read_back, ("deny", None, "use main as base"))
        # as the Claude app sends it: turned down, with the words, and Claude goes on in the same turn
        sent = approve_from_ccc.decision(*read_back[:1], "Bash", {}, None, read_back[2])["hookSpecificOutput"]["decision"]
        self.assertEqual(sent, {"behavior": "deny", "message": approve_from_ccc.FEEDBACK + "use main as base"})
        self.assertEqual(approve_from_ccc.FEEDBACK, serve.FEEDBACK)

    def test_a_reply_that_turned_a_box_down_shows_as_the_persons_message(self):
        content = [{"type": "tool_result", "tool_use_id": "toolu_1", "is_error": True, "content": serve.FEEDBACK + "New branch, on blog, from main"}]
        self.assertEqual(serve.user_items(content, 5), [{"kind": "you", "text": "New branch, on blog, from main", "images": 0, "at": 5}])
        self.assertEqual(serve.user_items([{"type": "tool_result", "tool_use_id": "t", "content": "ok"}], 5), [])

    def test_a_decision_for_a_box_no_longer_waiting_is_refused(self):
        self.assertIn("no longer waiting", self.approvals.give("s1", self.BOX, "allow", 12_000))
        self.note()
        self.assertIn("no longer waiting", self.approvals.give("s1", "ffffffffffffffff", "allow", 12_000))
        self.assertIn("no longer waiting", self.approvals.give("s1", self.BOX, "allow", 10_000 + serve.APPROVAL_BEAT_MS + 1))
        self.assertFalse((self.dir / "s1.answer.json").exists())

    def test_the_payload_shows_the_box(self):
        sessions_dir = self.dir / "sessions"
        sessions_dir.mkdir()
        (sessions_dir / "s1.json").write_text(json.dumps({"version": 1, "sessionId": "s1", "turn": {"startedAt": 10, "isRunning": True}}))
        self.note(beat=time.time() * 1000)
        payload = serve.board_payload(sessions_dir, serve.Removals(self.dir / "removed.json"), serve.Transcripts(self.dir / "none"), prompts_dir=self.dir, approvals_dir=self.dir)
        self.assertEqual(payload["sessions"][0]["turn"]["waiting"]["box"]["box"], self.BOX)


class ApprovalHookTest(unittest.TestCase):
    NOTICE = {"session_id": "s1", "tool_name": "Bash", "transcript_path": "/none", "tool_input": {"command": "gh api repos/x", "description": "Fetch files"}}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.old_dir = approve_from_ccc.APPROVALS_DIR
        approve_from_ccc.APPROVALS_DIR = self.dir

    def tearDown(self):
        approve_from_ccc.APPROVALS_DIR = self.old_dir
        self.tmp.cleanup()

    def test_only_a_main_thread_box_of_a_tool_without_its_own_box_is_taken(self):
        self.assertEqual(approve_from_ccc.box_of(self.NOTICE), ("s1", "Bash", self.NOTICE["tool_input"]))
        for bad in ({**self.NOTICE, "tool_name": "AskUserQuestion"}, {**self.NOTICE, "tool_name": "ExitPlanMode"}, {**self.NOTICE, "agent_id": "a1"},
                    {**self.NOTICE, "session_id": "../x"}, {**self.NOTICE, "tool_input": "ls"}, {**self.NOTICE, "tool_name": ""}, None):
            self.assertIsNone(approve_from_ccc.box_of(bad), bad)

    def test_the_note_shows_the_command_the_file_or_the_input(self):
        self.assertEqual(approve_from_ccc.shown("Bash", {"command": "ls", "description": "List"}), {"description": "List", "command": "ls"})
        self.assertEqual(approve_from_ccc.shown("Edit", {"file_path": "/a/b.py", "old_string": "x"}), {"description": "", "target": "/a/b.py"})
        self.assertEqual(approve_from_ccc.shown("WebFetch", {"url": "https://example.com", "prompt": "p"}), {"description": "", "target": "https://example.com"})
        self.assertEqual(approve_from_ccc.shown("mcp__x__y", {"title": "Hi"}), {"description": "", "detail": '{\n  "title": "Hi"\n}'})
        self.assertEqual(len(approve_from_ccc.shown("Bash", {"command": "x" * 30_000})["command"]), approve_from_ccc.COMMAND_MAX)

    def answer_when_asked(self, decision):
        """A sleep that answers the box from the board the first time the hook waits, as the server does."""
        clock = [1000.0]

        def sleep(_):
            note = json.loads((self.dir / "s1.box.json").read_text())
            (self.dir / "s1.answer.json").write_text(json.dumps({"box": note["box"], "decision": decision, "at": 1}))
            clock[0] += 0.5

        return clock, sleep

    def test_an_allow_from_ccc_goes_to_claude_once_and_the_note_comes_down(self):
        clock, sleep = self.answer_when_asked("allow")
        answer = approve_from_ccc.wait_for_decision("s1", "Bash", self.NOTICE["tool_input"], "/none", clock=lambda: clock[0], sleep=sleep)
        self.assertEqual(answer, {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}})
        self.assertFalse((self.dir / "s1.box.json").exists())
        self.assertFalse((self.dir / "s1.answer.json").exists())
        self.assertTrue((self.dir / "s1.answer.taken").exists())
        ended = json.loads((self.dir / "s1.ended.json").read_text())
        self.assertEqual((ended["at"], ended["endedAt"]), (1_000_000, 1_000_500))

    def test_a_deny_from_ccc_tells_claude_the_person_turned_it_down(self):
        clock, sleep = self.answer_when_asked("deny")
        answer = approve_from_ccc.wait_for_decision("s1", "Bash", self.NOTICE["tool_input"], "/none", clock=lambda: clock[0], sleep=sleep)
        self.assertEqual(answer["hookSpecificOutput"]["decision"], {"behavior": "deny", "message": approve_from_ccc.DENIED})

    def test_a_decision_left_for_another_box_is_not_taken(self):
        (self.dir / "s1.answer.json").write_text(json.dumps({"box": "ffffffffffffffff", "decision": "allow", "at": 1}))
        clock = [0.0]

        def tick(_):
            clock[0] += 100

        self.old_wait = approve_from_ccc.MAX_WAIT_S
        approve_from_ccc.MAX_WAIT_S = 300
        try:
            self.assertIsNone(approve_from_ccc.wait_for_decision("s1", "Bash", self.NOTICE["tool_input"], "/none", clock=lambda: clock[0], sleep=tick))
        finally:
            approve_from_ccc.MAX_WAIT_S = self.old_wait
        self.assertTrue((self.dir / "s1.answer.json").exists())
        self.assertFalse((self.dir / "s1.box.json").exists())

    def test_it_stops_when_the_call_was_answered_in_the_app(self):
        transcript = self.dir / "t.jsonl"
        call = {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "toolu_x", "name": "Bash", "input": {**self.NOTICE["tool_input"], "timeout": 5}}]}}
        transcript.write_text(json.dumps(call) + "\n")
        given = self.NOTICE["tool_input"]
        self.assertFalse(approve_from_ccc.answered_elsewhere(str(transcript), "Bash", given))
        done = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_x", "content": "The user does not want to proceed"}]}}
        with transcript.open("a") as handle:
            handle.write(json.dumps(done) + "\n")
        self.assertTrue(approve_from_ccc.answered_elsewhere(str(transcript), "Bash", given))
        self.assertFalse(approve_from_ccc.answered_elsewhere(str(transcript), "Bash", {"command": "other"}))
        self.assertFalse(approve_from_ccc.answered_elsewhere("/no/such/file", "Bash", given))
        # the same command asked again is a new box, waiting until its own result comes
        with transcript.open("a") as handle:
            handle.write(json.dumps({**call, "message": {"content": [{**call["message"]["content"][0], "id": "toolu_y"}]}}) + "\n")
        self.assertFalse(approve_from_ccc.answered_elsewhere(str(transcript), "Bash", given))
        with transcript.open("a") as handle:
            handle.write(json.dumps(done).replace("toolu_x", "toolu_y") + "\n")
        clock = [0.0]

        def tick(_):
            clock[0] += 1

        self.assertIsNone(approve_from_ccc.wait_for_decision("s1", "Bash", given, str(transcript), clock=lambda: clock[0], sleep=tick))
        self.assertLess(clock[0], 10)
        self.assertFalse((self.dir / "s1.box.json").exists())

    def test_the_note_is_renewed_while_it_waits_and_another_box_note_is_left_alone(self):
        beats = []
        clock = [0.0]

        def tick(_):
            clock[0] += 1
            beats.append(json.loads((self.dir / "s1.box.json").read_text())["beat"])
            if clock[0] >= 5:
                (self.dir / "s1.box.json").write_text(json.dumps({"box": "ffffffffffffffff", "tool": "Bash", "at": 1, "beat": 1}))
            if clock[0] >= 8:
                raise SystemExit(0)

        with self.assertRaises(SystemExit):
            approve_from_ccc.wait_for_decision("s1", "Bash", self.NOTICE["tool_input"], "/none", clock=lambda: clock[0], sleep=tick)
        self.assertGreater(max(beats[:4]), 0)
        self.assertEqual(json.loads((self.dir / "s1.box.json").read_text())["box"], "ffffffffffffffff")
        self.assertFalse((self.dir / "s1.ended.json").exists())

    def test_outside_the_app_and_vs_code_it_ends_at_once(self):
        result = subprocess.run(["/usr/bin/python3", str(Path(approve_from_ccc.__file__))], input=json.dumps(self.NOTICE).encode(), capture_output=True, timeout=10,
                                env={**{k: v for k, v in os.environ.items() if k != "CLAUDE_CODE_ENTRYPOINT"}, "CLAUDE_CODE_ENTRYPOINT": "cli", "CCC_APPROVALS_DIR": str(self.dir)})
        self.assertEqual((result.returncode, result.stdout), (0, b""))
        self.assertEqual(list(self.dir.iterdir()), [])

    def test_a_signal_from_claude_code_takes_the_note_down(self):
        process = subprocess.Popen(["/usr/bin/python3", str(Path(approve_from_ccc.__file__))], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   env={**os.environ, "CLAUDE_CODE_ENTRYPOINT": "claude-desktop", "CCC_APPROVALS_DIR": str(self.dir)})
        process.stdin.write(json.dumps(self.NOTICE).encode())
        process.stdin.close()
        deadline = time.time() + 5
        while not (self.dir / "s1.box.json").exists() and time.time() < deadline:
            time.sleep(0.05)
        self.assertTrue((self.dir / "s1.box.json").exists())
        process.terminate()
        out, _ = process.communicate(timeout=5)
        self.assertEqual((process.returncode, out), (0, b""))
        self.assertFalse((self.dir / "s1.box.json").exists())


class AddedConversationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.projects = self.dir / "projects"
        (self.projects / "-Users-me-app").mkdir(parents=True)
        self.folder = self.dir / "app"
        self.folder.mkdir()
        lines = [
            {"type": "user", "isMeta": True, "message": {"content": "<command-name>/clear</command-name>"}, "cwd": str(self.folder)},
            {"type": "user", "message": {"content": "  Fix the   login bug\nplease "}, "cwd": str(self.folder), "permissionMode": "auto", "entrypoint": "cli"},
        ]
        self.path = self.projects / "-Users-me-app" / "abc-1.jsonl"
        self.path.write_text("\n".join(json.dumps(line) for line in lines) + "\n")
        self.transcripts = serve.Transcripts(self.projects)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_conversation_is_named_by_its_first_prompt(self):
        self.assertEqual(serve.first_prompt(self.path), "Fix the login bug please")

    def test_an_added_conversation_with_no_snapshot_sleeps_on_the_board(self):
        pins = serve.Pins(self.dir / "pinned.json")
        pins.add("abc-1", 5000)
        pins.add("gone-2", 6000)
        payload = serve.board_payload(self.dir / "none", serve.Removals(self.dir / "r.json"), self.transcripts, prompts_dir=self.dir, approvals_dir=self.dir, pins=pins)
        [card] = payload["sessions"]
        self.assertEqual((card["sessionId"], card["title"], card["folder"], card["isAdded"], card["takesMessages"]), ("abc-1", "Fix the login bug please", "app", True, True))
        self.assertIsNotNone(card["endedAt"])
        self.assertTrue(isinstance(card["turn"]["startedAt"], int))
        self.assertEqual(card["permissionMode"], "auto")
        pins.drop("abc-1")
        self.assertEqual(list(pins.load()), ["gone-2"])

    def test_a_snapshot_of_its_own_wins_over_the_sleeping_card(self):
        self.assertEqual(serve.with_added([{"sessionId": "abc-1", "x": 1}], [], {"abc-1": 1}, self.transcripts), [{"sessionId": "abc-1", "x": 1}])
        self.assertEqual(serve.with_added([], [{"sessionId": "abc-1"}], {"abc-1": 1}, self.transcripts), [])

    def test_the_history_lists_conversations_newest_first(self):
        [one] = serve.existing_conversations(self.projects, self.transcripts, {"abc-1": "local_x"}, {"abc-1"})
        self.assertEqual((one["title"], one["folder"], one["where"], one["appSessionId"], one["onBoard"]), ("Fix the login bug please", str(self.folder), "app", "local_x", True))
        [two] = serve.existing_conversations(self.projects, self.transcripts, {}, set())
        self.assertEqual((two["where"], two["onBoard"]), ("terminal", False))

    def test_ending_stops_claude_then_clears_the_context(self):
        inbox = serve.Inbox(self.dir / "inbox", self.dir / "uploads")
        serve.end_session(inbox, "abc-1", 1000)
        stored = [json.loads(p.read_text()) for p in sorted((self.dir / "inbox" / "abc-1").glob("*.json"))]
        self.assertEqual([(m.get("stop"), m.get("text"), m.get("mode")) for m in stored], [(True, None, None), (None, "/clear", "queue")])

    def test_a_conversation_resumes_in_its_own_folder(self):
        body = json.dumps({"sessionId": "abc-1", "resume": True}).encode()
        self.assertEqual(serve.read_resume_request(body, self.transcripts), (os.path.realpath(self.folder), "abc-1"))
        self.assertIsNone(serve.read_resume_request(json.dumps({"sessionId": "nope", "resume": True}).encode(), self.transcripts))
        command = serve.resume_command("/a b", "abc-1", "iterm")
        self.assertEqual((command[0], command[-1]), ("osascript", "cd '/a b' && claude --resume abc-1"))
        self.assertIn('tell application "iTerm"', command[2])


class FileStepTest(unittest.TestCase):
    def test_a_step_on_a_file_says_which_and_the_lines_it_changed(self):
        self.assertEqual(serve.changed_lines("a = 1\n", "// Region\na = 1\n"), (1, 0))
        self.assertEqual(serve.changed_lines("a\nb\nc", "a\nB\nc\nd"), (2, 1))
        self.assertEqual(serve.changed_lines(None, "x"), (1, 0))
        edit = serve.tool_facts("Edit", {"file_path": "/repo/conf/integrations.plist", "old_string": "x", "new_string": "// y\nx"})
        self.assertEqual(edit, {"tool": "Edit", "file": "integrations.plist", "added": 1, "removed": 0})
        many = serve.tool_facts("MultiEdit", {"file_path": "/a.js", "edits": [{"old_string": "a", "new_string": "b"}, {"old_string": "c", "new_string": "c\nd"}]})
        self.assertEqual((many["added"], many["removed"]), (2, 1))
        self.assertEqual(serve.tool_facts("Write", {"file_path": "/n.txt", "content": "1\n2\n3"})["added"], 3)
        self.assertEqual(serve.tool_facts("Read", {"file_path": "/x/y.md"}), {"tool": "Read", "file": "y.md"})
        self.assertEqual(serve.tool_facts("Bash", {"command": "ls"}), {"tool": "Bash"})

    def test_an_opened_change_shows_its_lines_marked(self):
        diff = serve.step_diff("Edit", {"file_path": "/repo/integrations.plist", "old_string": "a = 1\nb = 2", "new_string": "// Region\na = 1\nb = 3"})
        self.assertEqual(diff["file"], "/repo/integrations.plist")
        self.assertEqual([(line["kind"], line["text"]) for line in diff["parts"][0]], [("add", "// Region"), ("same", "a = 1"), ("del", "b = 2"), ("add", "b = 3")])
        many = serve.step_diff("MultiEdit", {"file_path": "/a", "edits": [{"old_string": "x", "new_string": "y"}, {"old_string": "p", "new_string": "p\nq"}]})
        self.assertEqual(len(many["parts"]), 2)
        written = serve.step_diff("Write", {"file_path": "/n", "content": "1\n2"})
        self.assertEqual([line["kind"] for line in written["parts"][0]], ["add", "add"])
        big = serve.step_diff("Write", {"file_path": "/n", "content": "x\n" * (serve.DIFF_SHOWN_MAX + 5)})
        self.assertEqual((len(big["parts"][0]), big["isCut"]), (serve.DIFF_SHOWN_MAX, True))
        self.assertIsNone(serve.step_diff("Bash", {"command": "ls"}))

    def test_an_opened_change_shows_it_as_made_in_the_file_with_lines_around_it(self):
        saved = {"filePath": "/repo/integrations.plist", "structuredPatch": [{"oldStart": 8, "oldLines": 4, "newStart": 8, "newLines": 5, "lines": [
            "         {", "             key = bosbec;", "+            // Region Stockholm", "-            old = 1;", "+            new = 2;", "             url = x;", "\\ No newline at end of file"]}]}
        diff = serve.saved_diff("Edit", saved)
        self.assertEqual([(line["kind"], line["line"]) for line in diff["parts"][0]], [("same", 8), ("same", 9), ("add", 10), ("del", 10), ("add", 11), ("same", 12)])
        self.assertEqual(diff["parts"][0][2]["text"], "            // Region Stockholm")
        self.assertIsNone(serve.saved_diff("Edit", {"filePath": "/x"}))
        self.assertIsNone(serve.saved_diff("Bash", saved))


class TerminalAppTest(unittest.TestCase):
    def test_auto_is_iterm_when_installed_else_terminal(self):
        with tempfile.TemporaryDirectory() as apps:
            self.assertEqual(terminals.installed_apps(Path(apps)), [{"id": "terminal", "name": "Terminal"}])
            (Path(apps) / "iTerm.app").mkdir()
            found = terminals.installed_apps(Path(apps))
            self.assertEqual([app["id"] for app in found], ["iterm", "terminal"])
            self.assertEqual(terminals.chosen_app("auto", found), "iterm")
            self.assertEqual(terminals.chosen_app("terminal", found), "terminal")
            self.assertEqual(terminals.chosen_app("iterm", [{"id": "terminal", "name": "Terminal"}]), "terminal")


class EditorTest(unittest.TestCase):
    def test_the_editor_is_the_one_asked_for_else_the_one_running_else_the_first(self):
        with tempfile.TemporaryDirectory() as apps:
            self.assertEqual(editors.installed_editors(Path(apps)), [])
            (Path(apps) / "IntelliJ IDEA.app").mkdir()
            (Path(apps) / "Visual Studio Code - Insiders.app").mkdir()
            found = editors.installed_editors(Path(apps))
            self.assertEqual([editor["id"] for editor in found], ["intellij", "vscode"])
            self.assertEqual(editors.chosen_editor("vscode", found)["id"], "vscode")
            self.assertEqual(editors.chosen_editor("auto", found, running=lambda app: "Code" in app)["id"], "vscode")
            self.assertEqual(editors.chosen_editor("auto", found, running=lambda app: False)["id"], "intellij")
            self.assertIsNone(editors.chosen_editor("auto", []))

    def test_the_file_goes_to_the_editor_as_an_argument_at_its_line(self):
        idea = {"id": "intellij", "name": "IntelliJ IDEA", "app": "/Applications/IntelliJ IDEA.app"}
        code = {"id": "vscode", "name": "VS Code", "app": "/Applications/Visual Studio Code.app"}
        self.assertEqual(editors.open_command(idea, "/a b/x; rm.txt", 11), ["open", "-na", "/Applications/IntelliJ IDEA.app", "--args", "--line", "11", "/a b/x; rm.txt"])
        self.assertEqual(editors.open_command(code, "/a/x.txt", 0), ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", "--goto", "/a/x.txt:1"])
        self.assertEqual(editors.open_file(idea, "/no/such/file", 1), "That file is not there any more.")

    def test_only_a_file_a_step_touched_is_opened(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "integrations.plist"
            target.write_text("a\nb\n")
            transcript = Path(folder) / "s1.jsonl"
            use = {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "toolu_e1", "name": "Edit", "input": {"file_path": str(target), "old_string": "b", "new_string": "b\nc"}}]}}
            done = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_e1", "content": "ok"}]},
                    "toolUseResult": {"filePath": str(target), "structuredPatch": [{"oldStart": 1, "newStart": 1, "lines": [" a", " b", "+c"]}]}}
            transcript.write_text(json.dumps(use) + "\n" + json.dumps(done) + "\n")

            class Found:
                def find(self, session_id):
                    return transcript if session_id == "s1" else None
            opened = []
            idea = [{"id": "intellij", "name": "IntelliJ IDEA", "app": "/Applications/IntelliJ IDEA.app"}]
            answer = serve.open_step_file(Found(), {"sessionId": "s1", "toolId": "toolu_e1", "editor": "intellij"}, open_file=lambda editor, path, line: opened.append((path, line)) or "", installed=lambda: idea)
            self.assertEqual((answer, opened), ({"ok": True, "editor": "IntelliJ IDEA"}, [(str(target), 3)]))
            # a page can name a step, never a file
            self.assertFalse(serve.open_step_file(Found(), {"sessionId": "s1", "toolId": "toolu_x"}, installed=lambda: idea)["ok"])
            self.assertFalse(serve.open_step_file(Found(), {"sessionId": "../s1", "toolId": "toolu_e1"}, installed=lambda: idea)["ok"])
            self.assertIn("No editor", serve.open_step_file(Found(), {"sessionId": "s1", "toolId": "toolu_e1"}, installed=lambda: [])["problem"])


class TerminalKeyTest(unittest.TestCase):
    def test_a_terminal_needs_the_key(self):
        self.assertTrue(serve.has_terminal_key({"X-CCC-Key": "abc"}, "abc"))
        self.assertFalse(serve.has_terminal_key({"X-CCC-Key": "abd"}, "abc"))
        self.assertFalse(serve.has_terminal_key({}, "abc"))
        self.assertFalse(serve.has_terminal_key({"X-CCC-Key": ""}, ""))


class TerminalTest(unittest.TestCase):
    def setUp(self):
        # the shell may still write its history as it ends
        self.dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.folder = os.path.realpath(self.dir.name)
        self.terms = terminals.Terminals(environ={"SHELL": "/bin/sh", "PATH": "/usr/bin:/bin", "HOME": self.folder, "CCC_PORT": "1"})

    def tearDown(self):
        self.terms.stop_all()
        self.dir.cleanup()

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

    def test_a_shell_runs_in_its_folder_and_answers_what_is_typed(self):
        terminal_id, problem = self.terms.start(self.folder, 90, 30)
        self.assertEqual(problem, "")
        frames = self.terms.frames(beat_s=0.2)
        self.assertTrue(self.terms.type(terminal_id, "pwd; stty size; echo $TERM $CCC_PORT.\n"))
        seen = self.read_until(frames, terminal_id, b"xterm-256color .")
        self.assertIn(self.folder.encode(), seen)
        self.assertIn(b"30 90", seen)
        self.assertTrue(self.terms.resize(terminal_id, 100, 40))
        self.terms.type(terminal_id, "stty size\n")
        self.read_until(frames, terminal_id, b"40 100")
        self.assertEqual(self.terms.folder_now(terminal_id), self.folder)
        # after a cd the card says where the shell is now; the folder it started in stays
        inner = os.path.join(self.folder, "inner")
        os.mkdir(inner)
        self.terms.type(terminal_id, "cd inner && echo moved.\n")
        self.read_until(frames, terminal_id, b"moved.")
        time.sleep(0.3)
        self.terms.terminals[terminal_id].where_at = 0
        card = next(one for one in self.terms.list() if one["id"] == terminal_id)
        self.assertEqual((card["folder"], card["where"]), (self.folder, os.path.realpath(inner)))
        # a board that comes back gets what was printed, from the start
        again = self.terms.frames(beat_s=0.2)
        first = json.loads(next(again))
        self.assertTrue(first["reset"])
        self.assertIn(b"40 100", base64.b64decode(first["data"]))

    def test_a_shell_that_exits_is_marked_ended_and_a_closed_one_is_gone(self):
        terminal_id, _ = self.terms.start(self.folder)
        frames = self.terms.frames(beat_s=0.2)
        self.terms.type(terminal_id, "exit 3\n")
        deadline = time.time() + 5
        while time.time() < deadline:
            piece = json.loads(next(frames))
            if piece.get("ended"):
                break
        self.assertEqual((piece["id"], piece["exitCode"]), (terminal_id, 3))
        self.assertEqual(self.terms.list()[0]["exitCode"], 3)
        self.assertFalse(self.terms.type(terminal_id, "echo\n"))
        other, _ = self.terms.start(self.folder)
        self.assertTrue(self.terms.close(other))
        self.assertEqual([t["id"] for t in self.terms.list()], [terminal_id])
        self.assertFalse(self.terms.close("../x"))

    def test_closing_ends_a_shell_even_when_the_server_ignores_hang_ups(self):
        # ccc starts the server with nohup, which ignores hang-ups; the shell must not
        was = signal.signal(signal.SIGHUP, signal.SIG_IGN)
        try:
            terminal_id, _ = self.terms.start(self.folder)
        finally:
            signal.signal(signal.SIGHUP, was)
        pid = self.terms.get(terminal_id).pid
        frames = self.terms.frames(beat_s=0.2)
        self.terms.type(terminal_id, "trap -p HUP; echo ready.\n")
        self.read_until(frames, terminal_id, b"ready.")
        self.assertTrue(self.terms.close(terminal_id))
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            self.fail("the shell is still running after its card was closed")

    def test_what_a_start_asks_for_is_checked(self):
        self.assertEqual(self.terms.start("/no/such"), (None, "That folder is not on this Mac."))
        self.assertEqual(serve.terminal_action(self.terms, "terminal-start", {"folder": 5})["ok"], False)
        self.assertEqual(serve.terminal_action(self.terms, "terminal-type", {"id": "nope", "data": "x"}), {"ok": False})
        self.assertEqual(serve.terminal_action(self.terms, "terminal-open", {"id": "t000000000000"})["ok"], False)
        started = serve.terminal_action(self.terms, "terminal-start", {"folder": self.folder, "cols": 80, "rows": 20})
        self.assertTrue(started["ok"])

        class Done:
            returncode, stderr = 0, ""
        asked = []
        opened = serve.terminal_action(self.terms, "terminal-open", {"id": started["id"], "app": "terminal"}, run=lambda command, **k: asked.append(command) or Done())
        self.assertEqual(opened, {"ok": True})
        self.assertEqual(asked[0][-1], f"cd {self.folder}" if " " not in self.folder else asked[0][-1])



class MentionTest(unittest.TestCase):
    """The "@" menu of a write box: a session's files that match what was typed."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = os.path.realpath(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def touch(self, *paths):
        for path in paths:
            full = Path(self.folder) / path
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text("x")

    def test_the_best_match_comes_first_and_folders_are_offered_too(self):
        paths = mentions.with_folders(["README.md", "src/PushTalkService.kt", "src/push/PushTalkServiceTest.kt", "docs/talk.md", "src/main.kt"])
        self.assertEqual(paths[:3], ["docs/", "src/", "src/push/"])
        self.assertEqual(mentions.matches(paths, "PushTalkService")[:2], ["src/PushTalkService.kt", "src/push/PushTalkServiceTest.kt"])
        self.assertEqual(mentions.matches(paths, "push/"), ["src/push/", "src/push/PushTalkServiceTest.kt"])
        # its letters in order, when nothing holds it whole
        self.assertEqual(mentions.matches(paths, "ptsk"), ["src/PushTalkService.kt", "src/push/PushTalkServiceTest.kt"])
        # nothing typed: what lies at the top, folders first
        self.assertEqual(mentions.matches(paths, ""), ["docs/", "src/", "README.md"])
        self.assertEqual(mentions.matches(paths, "nothing-like-it"), [])

    def test_a_folder_outside_git_is_walked_without_packages_and_hidden_folders(self):
        self.touch("a.txt", "src/b.py", "node_modules/x/index.js", ".git/config", ".hidden/c.txt")
        self.assertIsNone(mentions.git_files(self.folder))
        self.assertEqual(mentions.walked_files(self.folder), ["a.txt", "src/b.py"])

    def test_in_a_repository_git_says_which_files_count(self):
        self.touch("kept.txt", "ignored.log", "new.txt")
        subprocess.run(["git", "init", "-q", self.folder], check=True)
        (Path(self.folder) / ".gitignore").write_text("*.log\n")
        subprocess.run(["git", "-C", self.folder, "add", "kept.txt"], check=True)
        self.assertEqual(sorted(mentions.git_files(self.folder)), [".gitignore", "kept.txt", "new.txt"])
        lists = mentions.FileLists(clock=lambda: 100)
        self.assertEqual(sorted(lists.files(self.folder)), [".gitignore", "kept.txt", "new.txt"])

    def test_a_session_gives_the_files_of_its_own_folder(self):
        self.touch("notes/todo.md")
        projects = Path(self.folder) / "projects"
        (projects / "p").mkdir(parents=True)
        (projects / "p" / "s1.jsonl").write_text(json.dumps({"type": "user", "cwd": self.folder, "message": {"content": "hi"}}) + "\n")
        transcripts = serve.Transcripts(projects)
        found = serve.session_files("s1", "todo", transcripts, mentions.FileLists())
        self.assertEqual((found["folder"], found["paths"]), (self.folder, ["notes/todo.md"]))
        self.assertEqual(serve.session_files("../etc", "x", transcripts, mentions.FileLists())["paths"], [])
        self.assertEqual(serve.session_files("nobody", "x", transcripts, mentions.FileLists())["paths"], [])

if __name__ == "__main__":
    unittest.main()
