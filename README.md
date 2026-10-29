# CCC: Claude Command Central

A live board of every Claude Code session on your Mac, from the Claude app, VS Code and the terminal. See what each one is doing, which ones need you, how full their context is, their agents, tokens and cost. Chat with them, answer their questions and approvals, and run terminals, all from one page.

![CCC in the Clean Dark theme](docs/screenshots/clean-dark.png)

## What you need

- macOS (might make this OS-independant in the future idk)
- Claude Code with mods (built on 2.1.312; mods are early access and may change)
- Python 3
- Google Chrome or Microsoft Edge, for the board's own window (optional)
- Node, only to run the board's tests

## Install

1. Clone it into your mods folder:

   ```bash
   git clone https://github.com/Frequill/claude-command-central.git ~/.claude/mods/ccc
   ```

2. Add this to `~/.claude/settings.json`, merged with what is already there. Replace `YOU` with your user name.

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "/Users/YOU/.claude/mods/ccc",
       "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
     },
     "hooks": {
       "Notification": [
         { "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "/usr/bin/python3 /Users/YOU/.claude/mods/ccc/board/prompt_seen.py", "timeout": 10 }] }
       ],
       "PermissionRequest": [
         { "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "/usr/bin/python3 /Users/YOU/.claude/mods/ccc/board/answer_from_ccc.py", "timeout": 3600 }] },
         { "matcher": "*", "hooks": [{ "type": "command", "command": "/usr/bin/python3 /Users/YOU/.claude/mods/ccc/board/approve_from_ccc.py", "timeout": 3600 }] }
       ]
     }
   }
   ```

3. Add the `ccc` command to `~/.zshrc`:

   ```bash
   ccc() {
     "$HOME/.claude/mods/ccc/board/ccc" "$@"
     local code=$?
     if [ $code -eq 100 ]; then exit; fi
     return $code
   }
   ```

4. Open a new terminal and run `ccc`. `ccc stop` stops the board's server.

Sessions already running pick CCC up when their current turn ends; new ones have it right away.

## Sessions in the background

The **+** in the header starts a session **in the background** by default: CCC runs `claude` itself, in the folder and mode you pick, with your first message, and nothing opens. It shows up on the board like any other session, and you chat with it, answer its questions and approve its steps there. Its `>_` button shows the terminal it runs in; the × on that terminal hides it again, and Claude keeps working. The ⓘ next to the choice says what it means.

Closing its card offers **Close from CCC** (Claude keeps working; Settings → Background sessions shows it again) or **End it** (Claude stops; the conversation stays in Claude's history, to pick up again from + → From an existing conversation or `claude --resume`).

In a folder Claude was never told to trust, Claude asks first. Its terminal then comes onto the board, so you can answer.

The terminals on the board, background sessions included, run in CCC's keeper (`board/keeper.py`), a small program of its own that CCC starts when it needs it. So they keep running when you close the Claude app, your terminal windows or the board's server. `ccc stop` stops only the server; the next `ccc` finds them again. `ccc stop --all` also stops the keeper, which ends them (it asks first). A restart of your Mac ends them too.

**Settings → Background sessions** lists what runs in the keeper, with Show and End for each and End everything for all. A background session that stopped without you ending it (your Mac restarted) is listed there under Stopped, to resume in the background again; Claude starts only with a message, so it goes in with one. Nothing resumes by itself. After an update of CCC, a keeper with things running in it keeps its old code until you restart it there.

Every working agent and background command on the agent map has a **Stop**: click it, then click again within a few seconds, and that one ends while its session's turn goes on.

## Themes

Twelve of them, from Clean to Cyberpunk 2077. Pick one in Settings.

| | | |
|---|---|---|
| ![Clean](docs/screenshots/clean.png) | ![macOS](docs/screenshots/macos.png) | ![Windows 98](docs/screenshots/win98.png) |
| ![Inferno](docs/screenshots/inferno.png) | ![Cyberpunk 2077](docs/screenshots/cyberpunk.png) | ![Evangelion](docs/screenshots/eva.png) |

## Safety

The board only listens on `127.0.0.1` and refuses requests from other pages. It can run shells and approve Claude's tool calls, so never expose it beyond your own machine. The keeper listens on `127.0.0.1` too, and answers only requests that carry the key in `~/.claude/ccc/keeper.json`, a file only your user can read.

## Tests

```bash
cd ~/.claude/mods/ccc/board && python3 -m unittest test_serve test_keeper && node --test test_board.mjs && bash test_ccc.sh
```

```bash
claude plugin test ~/.claude/mods/ccc
```

## Credits

Version 1.0 was created by [Love Klockars](https://github.com/lokl4297). Fan themes are a hobby: their names and logos belong to their owners, and this project is not for sale.
