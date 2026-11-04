# Keyboard shortcuts: CCC without a mouse

## Goal

Everything on the board can be done from the keyboard, the way tabs work in iTerm or a browser:
start a session, close one, move from card to card (landing in its write box), and work the menus
and boxes with the arrow keys and Enter. Every shortcut can be changed in a new **Keys** tab in
Settings, with **Reset to defaults**.

The defaults asked for:

| Shortcut | Does |
| --- | --- |
| Cmd+T | New session (the start window) |
| Cmd+W | Close the current card (the same Close dialog as its X) |
| Option+Cmd+←/→/↑/↓ | Go to the card in that direction (Claude or terminal), into its write box; works from inside a text field too |
| Arrow keys, Enter | Move through and pick in menus, dialogs and boxes |

## How it works today

- **No shortcuts and no "current card".** The board has no idea which card you're on. Focus is
  wherever the browser put it last.
- **Keys the board already listens to:**
  - The scroll buttons can be held keys or mouse buttons (`board.js:1142`, `onKey`, on `window` in
    the capture phase).
  - The settings tab bar moves with ←/→ (`settings.js:68`).
  - Settings already has a "press a key or a mouse button" picker for the scroll buttons
    (`settings.js` ~110–145). Rebinding can reuse it.
  - The write box: Enter sends, Shift+Enter makes a new line, Cmd+Enter sends now (`chat.js:210`).
    The "/" and "@" menus already move with ↑/↓ and pick with Enter.
  - The code-chip menu moves with ↑/↓ (`chat.js`, `codeMenu`).
  - Escape lets go of a side panel's scroll (`chat.js:1670`).
- **Cards** are gridstack tiles: Claude chats (`[data-session]`) and terminal cards (xterm, focused
  with `xterm.focus()`, `terminal.js:432`). Where each one is comes from its own position on screen.
- **New session** is `#start-dialog` (`board.js:456`). **Close** is `askToRemove(id, title)`, the
  dialog with Close / Close and delete.
- **Settings** has the tabs `look, board, behaviour, terminal, background` (`board-logic.js:169`),
  stored in `localStorage` under `ccc.settings`.
- **The window** is a Chrome (or Edge) `--app` window that `board/ccc` opens (`open_board`).

### The catch: keys Chrome keeps

Chrome doesn't let a page take some shortcuts: **Cmd+T, Cmd+W, Cmd+N, Cmd+Shift+T, Cmd+Shift+N,
Cmd+Q**, and possibly tab switching (Cmd+Option+←/→, Ctrl+Tab, Cmd+1–9). The browser acts on them
before the page hears them, and the page can't stop that. In CCC's app window, Cmd+W would close
the whole board window, and Cmd+T would open a Chrome tab. App windows may behave differently from
normal ones, so step 1 tests this in CCC's own window before anything is built on it.

If Chrome keeps them, the options are:
- **(a)** Defaults Chrome leaves alone: Ctrl+T and Ctrl+W (Ctrl is free in Chrome on a Mac), or
  Option+Cmd+T and Option+Cmd+W. Cmd+T and Cmd+W can still be bound, with a note saying Chrome
  takes them.
- **(b)** Later, CCC in a small window of its own (a tiny native app around the board), where every
  key is CCC's. That's a project of its own, not part of this plan.

## Approach

**Recommended: one keymap and one listener.**

- **`board/keys.js` (new, pure, tested):**
  - shortcuts written as text (`"Alt+Meta+ArrowLeft"`);
  - shown as a Mac shows them (`⌥⌘←`);
  - matching a key press, using `event.code`, so a Swedish layout matches the same keys;
  - the default keymap;
  - finding a shortcut bound twice.
- **One listener on `window`, in the capture phase:** it looks a key press up in the keymap and runs
  the command. It goes first, before the write box or an xterm, so Option+Cmd+arrows leave a text
  field. Keys that aren't bound pass on untouched, so typing in a terminal is unchanged.
- **Commands:** a small table of id → function (`newSession`, `closeCard`, `cardLeft` …). The keymap
  says which keys run which id; the Keys tab lists the same table.
- **The current card:** the card that last had focus, followed with `focusin`, with a clear ring so
  you always see where you are. Landing on a card focuses its write box, or the xterm for a
  terminal.
- **Moving between cards:** from the current card's place on screen, the nearest card whose centre
  lies in that direction, by angle and distance. Hidden and folded cards are skipped.
- **Menus and boxes:** one small helper that lets ←/→/↑/↓ move between a group's buttons and
  Enter/Space pick, used by:
  - the session menu (model, effort, caveman, mode),
  - the Close dialog,
  - question and approval boxes,
  - the start window.

  Tab still goes from group to group, as browsers do.
- **Rebinding:** a **Keys** tab in Settings listing every command with its shortcut, a **Change**
  button that uses the existing key picker, a warning when a shortcut is taken (by another command
  or by Chrome), and **Reset to defaults**. Saved in `ccc.settings` with the other settings.

**Rejected: a handler on each element** (the write box, every button group, every dialog). That's
how today's few keys are done, and it's fine for one key. For a whole keymap it would scatter the
bindings over many files, the Keys tab couldn't list them, and a shortcut would only work where its
element has focus, so moving between cards couldn't work from inside a text field.

**Deferred: a native wrapper app** (option (b) above). It's the only way to own Cmd+T and Cmd+W if
Chrome keeps them. It changes how CCC is installed and opened, so it should be decided apart from
the shortcuts.

## Suggested extras

Beyond the four asked for:

| Shortcut (suggested) | Does |
| --- | --- |
| Cmd+K | **Command palette**: type to find any session or action and press Enter. The biggest single win for mouseless use |
| Cmd+/ | Cheat sheet of every shortcut, over the board |
| Cmd+Shift+] / Cmd+Shift+[ | Next / previous card in board order, as browser tabs go |
| Cmd+1 … Cmd+9 | Card 1–9 (if Chrome leaves them to the page) |
| Option+Cmd+N | Jump to the next card that **needs you** (a question or approval waiting) |
| Cmd+. | Stop Claude in the current card |
| Cmd+Shift+M | Open or close the current card's session menu (model, effort, mode) |
| Cmd+J | Show or hide the card's facts panel |
| Cmd+E | Show or hide a background session's terminal (`>_`) |
| Cmd+Shift+K | Caveman on or off |
| Option+Cmd+T | New terminal card |
| 1, 2, 3… / Y, N | In a waiting box with focus: pick the option with that number, Allow or Deny |
| Esc | Close the open menu, dialog or palette; back to the write box |

## Steps

- [x] 1. **Test which shortcuts reach the page** in CCC's own Chrome app window. A small throwaway
      page logs each key press; you press the candidates. Note the result here and settle the
      defaults. (Result under "Decisions made along the way".)
- [x] 2. **Add `board/keys.js`**: parse, show and match shortcuts, the default keymap, finding
      clashes. Tests in `test_board.mjs`.
- [x] 3. **Add the command table and the one listener**, with the first command, **New session**.
- [x] 4. **Track the current card** (focus ring, landing in the write box or terminal) and add
      **Close card**, through the existing Close dialog.
- [x] 5. **Move between cards with Option+Cmd+arrows**, from anywhere, terminals included.
- [x] 6. **Arrow keys and Enter in menus and boxes**: the button-group helper, used by the session
      menu, the Close dialog, question and approval boxes, and the start window.
- [x] 7. **The remaining commands** from the extras we keep (stop, menu, panel, terminal, next needs
      you, card N…).
- [x] 8. **The Keys tab in Settings**: list, change with the key picker, clash warnings, reset to
      defaults.
- [x] 9. **The cheat sheet (Cmd+/)**, and the README. (The palette is the cheat sheet; see below.)
- [x] 10. **The command palette (Cmd+K)**, if we keep it. It's the largest extra, so it goes last.
- [ ] 11. **A full run without the mouse** in the real board window, with you.

Each step leaves the board working. Steps 3–7 only add keys, so with no key pressed nothing
changes.

## Open questions

1. **Cmd+T / Cmd+W:** if step 1 shows Chrome keeps them, which defaults do you want: Ctrl+T/Ctrl+W,
   or Option+Cmd+T/Option+Cmd+W? (Or the native wrapper later.)
2. **Cmd+W on a card where Claude works:** the same Close dialog as the X (Enter = Close), or close
   at once?
3. **Which extras** are in for this round? The command palette is the big one.
4. **Terminal cards:** keys typed in a terminal belong to the shell, except the bound shortcuts.
   Should a shell's own keys (Ctrl+A, Ctrl+R …) ever be taken by CCC? I'd say never by default.
5. **Rebinding per Mac:** shortcuts saved like the other settings, in this browser on this Mac. Fine?

## Decisions made along the way

**Step 1, which keys reach the page (Nov 3, Chrome app window, Swedish keyboard).**

- **Reached the page:**
  - Cmd+T, Cmd+N, Cmd+Shift+T, **Cmd+W**: a Chrome app window does not keep them, so the defaults
    asked for work as they are.
  - Option+Cmd+←/→/↑/↓.
  - Cmd+1, 2, 9.
  - Cmd+K, Cmd+., Cmd+, (comma) and Cmd+J.
  - Cmd+Shift+M, K, N, T, W, E and Cmd+Shift+←/→.
  - Option+Cmd+N, T, W.
  - Ctrl+T, Ctrl+W and Ctrl+Tab.
- **Did not reach it:** Cmd+E, kept by Chrome or macOS. Leave it out.
- **Keyboard layout:** Cmd+Shift+] / [ and Cmd+/ can't be pressed as such on a Swedish keyboard
  (`]` and `[` are Option+9 and Option+8, and `/` is Shift+7). With Cmd held, Chrome reports the
  key without Shift (Cmd+Shift+7 comes as `key=7`), so `event.key` is no use for matching.
  - **Decision:** match on `event.code` (the physical key).
  - **Decision:** default shortcuts use letters, digits, arrows and Tab only, never symbol keys.
  - **Decision:** the Keys tab and cheat sheet show each shortcut as the person's own keyboard
    writes it, using Chrome's keyboard layout map.
- **Not tested yet:** Option+Cmd+arrows from inside a text field (none of the presses came from the
  text box). The listener sits on `window` in the capture phase, before the text field, so it
  should work; step 5 checks it.
- **Defaults to avoid:** keys macOS keeps for itself: Cmd+H, Cmd+M, Cmd+Q, Cmd+Tab and Cmd+`.

**Step 3.**
- **New session** presses the header's + button (`#new-session`), so it takes exactly the path the
  mouse does.
- **While any dialog is open,** no shortcut runs. That covers the start window, Settings and its key
  picker, and the background-sessions explainer. The dialog keeps its own keys: arrows, Enter, Esc.
  Moving around inside dialogs is step 6.
- **A command with no code yet** lets its key pass through to the browser unchanged. Until step 4,
  Cmd+W still does what Chrome does with it.
- **A held key** runs its command once.

**Step 4.**
- **The current card** is the last `.expanded-tile[data-session]` that focus went into or that was
  clicked (`setupCurrentCard` in `board.js`). Claude cards and terminal cards are both such tiles.
- **The ring** (`body.keys-used .is-current`) shows once a shortcut or Tab is used, and goes on the
  next click, like a browser's focus ring, so mouse use looks as before.
- **Cmd+W presses the current card's X,** so each kind of card gets its own Close dialog.
- **With no current card, Cmd+W is still swallowed:** it must never fall through to Chrome and
  close the board window.
- **Testing note:** the browser pane has no keyboard focus while Claude works there, so it sends no
  focus events. Step 4 was checked with clicks and synthetic focus events; the real window gets
  real ones.

**Step 5.**
- **`cardInDirection` (keys.js)** picks the card:
  1. A card counts only if its near edge is past the middle of the current card that way. The first
     test caught a wide card *under* A being taken as "to A's right", because its middle lay further
     right.
  2. Cards in line come before cards off to the side.
  3. Then the nearest one.
  4. Then the one most in line.

  It never wraps round.
- **Starting point:** with no current card, the keys start at the top-left card (`firstCard`).
- **Landing:** `landIn` (board.js) makes the card current, scrolls it into view and focuses its write
  box (`focusChat`) or its terminal (`focusTerminal`).
- **Held keys:** the move keys repeat while held; the other commands still run once.
- **Checked on the scratch board:** moving round a 2×2 grid, from inside a write box (the key is
  stopped, so nothing is typed), and landing in the next card's write box.
- **Still to check:** landing in a terminal card. There's none on the scratch board, so it goes into
  step 11's full run.

**Step 6.**
- **One listener for button groups** (`setupArrowKeys`, board.js):
  - **Groups:** whatever is marked `role="group"` / `"radiogroup"` / `"toolbar"`, plus the Close
    dialog's choices, dialogs' action rows and the foot of question and approval boxes.
  - **Rows and lists:** a group laid out downwards (`flex-direction: column`) is a list. The page's
    own layout says so, with no extra markup.
- **The keys:**
  - **In a row:** ←/→ move along it, and ↑/↓ go to the row above or below, landing on the button
    most in line.
  - **In a list:** ↑/↓ move along it, and past its end go on to the next row.
  - **Coming into a list** from below lands on its last item, from above on its first. Found in
    testing: ↑ from Cancel first jumped to the top of the Close choices.
- **Where it applies:** only when a button has focus. In a text field the arrows still move the
  cursor; text fields are reached with Tab.
- **Esc** in the session menu closes it and puts the cursor back in the write box.
- **A focus mark** for buttons the keyboard is on (`body.keys-used …:focus-visible`), so the
  Cyberpunk theme's lack of outlines can't hide where you are.
- **Checked on the scratch board:** the session menu (rows, down and up, Esc), the Close dialog
  (cancelled each time) and the start window.
- **Still to check:** question and approval boxes in a live session. They use the same groups
  (`.q-options`, `.q-actions`), so this goes into step 11.

**Step 7.**
- **Each command presses the button the mouse would:**
  - Stop: the card's `.compose-stop`, only while shown.
  - Facts panel: `.side-toggle`.
  - Terminal: `.terminal-toggle`, only when it can open.
  - Caveman: `.caveman-toggle`.
  - Settings: `#settings-open`.
  - New terminal: the + and then the start window's "New terminal".
- **Reading order** (keys.js):
  - `readingOrder` goes row by row, cards whose tops are within 24 px counting as one row.
  - `cardInOrder` (Ctrl+Tab, Ctrl+Shift+Tab) goes round.
  - `cardNumber` (Cmd+1–8) takes that card, and Cmd+9 the last, as in Chrome.
  - `nextWaiting` (Option+Cmd+N) finds the next card whose header shows **Needs you**, after the
    current one.
- **The session menu** (Cmd+Shift+M) opens and puts the cursor on its lit choice, so the arrow keys
  work at once. The menu is drawn once the session's model list has come, so it waits for it with a
  short timer: `requestAnimationFrame` doesn't run in a window that isn't showing. A second
  Cmd+Shift+M closes it and goes back to the write box.
- **Held keys:** Ctrl+Tab repeats while held, like the arrows.
- **Bug found and fixed:** three defaults were written `Meta+Shift+…` while key presses come as
  `Shift+Meta+…`, so Cmd+Shift+M, E and K never matched. The defaults are now written the way key
  presses are, `bindings()` tidies any default as well, and a test holds every default to it.
- **Checked on the scratch board:** Ctrl+Tab / Ctrl+Shift+Tab round three cards, Cmd+1/3/9 (and
  Cmd+5 with only three cards stays put), Cmd+J, Cmd+Shift+M with ↓ and Esc, Cmd+, and
  Option+Cmd+T.
- **Not tried:** Stop and caveman, which would act on your real sessions, plus Needs you and the
  terminal button (no such card on the scratch board). They go into step 11.


**From step 8 on, built without stopping between steps** (you asked to go on to the end).

**Step 8, the Keys tab.**
- **Saving:** `normalizeSettings` keeps a `keys` field, `{ commandId: [shortcut] }`, with only real
  changes (`cleanCustom`). `applySettings` builds `view.keymap` from it, so a change counts at once,
  with no reload.
- **The tab** (`setupKeys`, settings.js):
  - A row for each command, grouped as `COMMANDS` is, with its shortcut written the way your
    keyboard writes it (Chrome's layout map).
  - **Change** waits for the next keys; **Esc** cancels the waiting and leaves Settings open.
  - **×** removes a shortcut; **Reset to defaults** puts every one back.
  - A note says what happened, and clears when Settings closes.
- **The rules** (keys.js):
  - `bindProblem` refuses a shortcut without Cmd, Ctrl or Option (function keys are fine), so typing
    is never taken over, and refuses the keys Chrome or macOS keep.
  - `rebind` moves a shortcut that another command had, so clashes can't happen from the tab, and
    the note says which command lost it.
- **Checked:** changing Stop to ⌘K (the palette was left with no key and both rows marked
  "changed"), a plain letter refused, Esc, ×, Reset, and New session on ⌃N working at once while
  ⌘T didn't.

**Step 9, the cheat sheet:** no key of its own, as agreed (`/` is Shift+7 on a Swedish keyboard).
The palette lists every command with its shortcut, and the Keys tab lists them all too. The README
has the table.

**Step 10, the command palette (⌘K, `openPalette` in board.js):**
- **Rows:** the cards in reading order (name, Claude or Terminal, its state), then every command
  with its shortcut. Card 1–9 are left out, since the cards are listed by name.
- **Finding:** typing narrows the rows (`paletteMatches`: every word somewhere in the row, names
  that start with the first word first). ↑ ↓ move, Enter goes to the card or runs the command after
  the palette closes, and Esc closes it.
- **Checked:** "facts" finds the facts panel, and "set" + Enter opened Settings.

**Step 11, still to do with you in the real board window:**
- **Not covered on the scratch board:** real focus events, landing in a terminal card, question and
  approval boxes in a live session, Stop, caveman, Needs you, and the terminal button. The browser
  pane has no keyboard focus while Claude works there, and the rest would act on your real sessions.

**After the first try in the real board (you):**
- **"Reset to defaults" wasn't to be found:** it sat under all 26 rows. It's now at the top of the
  Keys tab, and each changed row has a ↺ that puts just that one back. The ↺ keeps its place on
  unchanged rows (invisible), so the rows line up.
- **The shortcuts were on for everyone straight away:** there's now a **Keyboard shortcuts** switch
  at the top of the tab, **off by default** (`settings.shortcuts`). Off, the listener lets every key
  through, so ⌘W closes the window as in any other, and the list is greyed but can still be edited.
  The arrow keys inside menus and dialogs stay on either way: they're how menus work, and take no
  key from anything.

**Speed (your idea):**
- **In the start window, Enter starts and Space picks.** Enter starts whatever is highlighted;
  Space presses the highlighted button (a folder, a place, a mode), as the browser already does. So
  ⌘T and then Enter starts a session as the window shows it. In the first message's box Enter stays
  a new line, and ⌘Enter starts; in a menu Enter picks. A note in the window says so.
- **Quick new session** (`quickNew`, no key by default) starts one in the background at once, with
  no window. It uses the folder the start window has (picked last, else the most recent), its mode
  and "In the background". Its card comes onto the board as the current card, with the cursor in it
  for the first message. When there's no folder at all, a short note at the bottom of the board says
  to start one with ⌘T first.
- **Checked on the scratch board:** Enter on a folder started a background session and closed the
  window, and the bound Quick new made a new card with no window, current at once. Both were only
  cards (no Claude starts before the first message) and have been removed.

**Arriving at a card (your idea):** `landIn` used to scroll "just enough", which could leave you
halfway down a card. It now jumps the board to the card's top at once, to the place the context
radar glides to (`cardTop`, taken out of the radar's handler so both use one rule), with no glide.
For a Claude card, it also scrolls the chat to its newest messages (`showNewest` in chat.js), and the
chat follows Claude from there. Checked on the scratch board: the scroll happens in the same moment
as the key press, the card's top lands just under the bars, and a chat scrolled 23,382 px up showed
its newest at once.

**Answering with number keys (your idea):**
- **Questions:** with shortcuts on and the cursor on a question box, **1–9** pick that option
  (`optionNumber`, keys.js; `pickByNumber`, chat.js). One question with one choice is sent at once,
  as in Claude's terminal box. Otherwise the cursor goes on to the next question, or to Send answer.
  "Other" opens its field. Each option shows its number.
- **Approvals:** **1** allows once and **2** denies, both numbered.
- **No accidental answers:** numbers only answer with the cursor on the box. In a write box or the
  "Other" field they're typed as always, so a "2" meant for your message never answers a question.
- **Getting there:** arriving at a card whose box waits puts the cursor on the box
  (`waitingBoxButton`). ⌥⌘N goes into the current card's own box first, when the cursor isn't on it,
  so ⌥⌘N and then a number answers the next question on the board.
- **Checked live:** a throwaway Haiku terminal session asked about seasons. ⌥⌘N from another card
  landed on its first option, the options showed 1–5, and **2** sent "Summer"; Claude answered
  "You picked Summer." Approvals use the same key handling but weren't tried live.

**The cursor fell off after a pick (you found it):**
- **The cause:** picking a folder with Space redrew the folder list, so the button the cursor was on
  was replaced. The cursor fell back onto the page and the arrows stopped working. The session menu
  and the Keys tab redraw on a pick too.
- **The fix:** `refocus.js` notes the cursor's button before a redraw (its group's name, its data,
  its words, its place) and puts the cursor on the matching new button after it. It's used by the
  start window's folder list, the session menu (inside `drawSetup`, so every way it redraws is
  covered) and the Keys tab.
- **One more catch:** a menu pick greys out its button while it saves, which drops the cursor before
  the redraw. So the menu notes the button pressed at the press itself (`chat.setupFocus`).
- **Checked:** Space on "aurora" then ↓ ↑ moved on from there; picking Default in the session menu
  kept the cursor there and → went on to Sonnet (nothing saved); Change, Esc, ↓ in the Keys tab.

**The board scrolled up before going down to a new card (you found it):**
- **The likely cause:** `showPlanned` asked the board to go to the new card straight after drawing
  it, before the grid had put the card in its place, so it seemed near the top and the glide set off
  upwards. Then the keyboard landing jumped down to the right place 400 ms later. A new terminal had
  the same immediate "go to it".
- **The fix in the handler** (`ccc:show-session`), so it covers every caller (new session, new
  terminal, a card added from history): it waits until the card holds still (`settledOnBoard`, two
  equal looks 40 ms apart, at most 0.8 s) before working out where to glide.
- **And the start window:** it now closes without moving the board (`closeKeepingPlace`). On
  closing, the browser puts the cursor back in the card you came from and could scroll there first.
- **`showPlanned`** makes the new card current at once and lets the one glide take the board there;
  the second, instant jump is gone.
- **Not shown on the scratch board:** its cards are scaled to fit, so it barely scrolls, and the
  browser pane runs no glide while it isn't showing. This needs checking in the real board window.

**After closing a card, the keys started from the top of the board (you found it):**
- **The cause:** closing the current card left no current card, so the next ⌥⌘arrow or ⌃Tab started
  from the top-left card, way up the board. The cursor also fell onto the page with the closed card.
- **The fix:** `drawBoard`, where every card leaves the board (Close, Close and delete, a terminal
  closed, a session ended elsewhere), notes where the current card was. `handOff` then makes the card
  nearest to that spot (`nearestCard`, keys.js: closest middle) the current one, puts the cursor in
  it and leaves the board where it was. The cursor only moves if it was in the closed card or nowhere.
- **Checked:** closing the current card through the server, as the dialog does, made the nearest card
  current with the cursor in it, and the board didn't scroll. `nearestCard` has a test of a card far
  down the board handing on to its neighbour, not to the top card. (The dialog itself couldn't be
  driven in the test pane: Chrome sends its close event on the next frame, and the pane draws none
  while Claude works there.)

**Card names (your question):**
- **The cause:** cards were named by a `/rename` name or the Claude app's own title, and otherwise by
  the start of the first message. Terminal and background sessions only get Claude Code's summary (an
  `ai-title` record), which CCC didn't read.
- **Order now** (`facts_in`, serve.py):
  1. a name given in CCC,
  2. a `/rename` name or the app's title,
  3. Claude's latest summary,
  4. the start of the first message.

  A summary near the end of a transcript doesn't hide a name given further back: the whole file is
  read then.
- **Renaming:**
  - **How:** double-click the name in a card's header, or press **F2** (`renameCard`, changeable).
  - **Keys:** Enter keeps the new name, Esc keeps the old one, and an empty name goes back to the
    automatic one.
  - **Where it's kept:** in `~/.claude/ccc/names.json` (`Names`), shown at once for any session.
  - **Claude's own lists:** a session that runs CCC's mod is also sent `/rename`, so `/resume` matches;
    in the chat that shows as the note "Renamed to …".
  - **Deleting a conversation** forgets its name.
- **Checked on the scratch board** (with its own names file and outbox): summaries showed for terminal
  sessions, such as "Teleq-application mobile UI improvements"; renaming, Esc and the empty name all
  worked, and the `/rename` went only into the scratch outbox.

**A button answer waited behind a queued message (your idea):**
- **The cause:** a message queued while Claude worked went in the moment the turn ended, even when
  that turn ended with a question and buttons, so the button answer came too late.
- **The fix in the mod's inbox:** `isHeld` holds a queued message that was queued while the turn ran
  that then ended with a question whose buttons are still up (`heldWindow` in register.tsx: that
  turn's start and end).
  - **Goes in at once:** the answer, whether a button or anything written after the question.
  - **Then:** the held message goes in when the answer's turn is done, like any queued one. It is
    held only for the question of the turn it was queued in, never again, because almost every turn
    here ends with buttons.
  - **Send now** still sends it at once.
- **The board** says so under a held message: "waits for your answer to Claude's question, which
  goes in first" (`isHeldForAnswer`, chat-logic.js).
- **Not tried live:** the buttons come from the Claude app's next-step box, which only app sessions
  have, and a running session gets new mod code only once it's installed. The tests cover the rule
  and the order.

**Closing the bottom row left the view below the last card (you found it):**
- **The cause:** `keptRoom` (grid.js) keeps the board as tall as it was when a card closes, so
  nothing jumps under you, and gives the room back only as you scroll up. For a closed bottom row,
  that left the window looking at empty board.
- **The fix:** after cards leave the board, `backInBounds` (board.js) checks whether the part of the
  window that shows the board, above the status bar, is a third or more empty below the lowest card
  left. If so, it glides up until that card's bottom meets the bottom of the view (`backUpTo`,
  keys.js), or to the top when no card is left. The board's own small room under its last card is
  no reason to move, so closing a card elsewhere never nudges the view.
- **Checked:** `backUpTo` is tested (a full gap, cards still filling the view, no card left, already
  at the top). The glide itself can't run in the test pane.

**Closing card 4 went to 2, not 3 (you found it):** `nearestCard` picked by plain distance, and with
cards wider than they are tall, the card above was nearer than the one beside it. It now works like
a closed browser tab: a neighbour in the same row (sharing some of its height) comes first, the
nearest of those; only a card alone in its row goes to the nearest card above or below. Tested with
your 2×2 board: closing 4 goes to 3, closing 2 goes to 1.

**The next-step box by number (your idea, "as the CLI works"):**
- **The box:** with shortcuts on, its answers show 1, 2…, followed by **Write your own**, which puts
  the cursor in the write box. A number with the cursor on the box picks that answer.
- **In an empty write box** (`answerByNumber`, chat.js), a number answers whichever box waits, as
  Claude's own boxes take one: an approval (1 allows once, 2 denies), else a question (that option,
  through `pickByNumber`), else the next-step box. Once anything is typed, numbers are text again,
  so a message starting with a digit is never taken for an answer. Only real option buttons count:
  a question answerable only elsewhere draws its options as text, and never swallows a number.
- **Not tried live:** the next-step box only shows once a turn of an app session ends.

**The conversation list in the start window was out of the keys' reach (you found it):** the search
field keeps the arrows for its cursor, and the rows weren't groups.
- **Rows:** each row's buttons (`.existing-actions`) are a row for the arrow helper now, so ←/→ move
  within a row and ↑/↓ between rows on the same button. The lists in Settings, Background sessions
  move that way too.
- **The search field:** ↓ goes into the list, onto the first row's main button, and ↑ from the first
  row goes back up.
- **Enter in the search** takes the top match: Add to CCC, or, when it's on the board already, closes
  the window and goes to its card. In this mode Enter no longer means Start, so on a highlighted
  button it presses that button.
- **Checked on the scratch board:** down into the list, down and up between rows, back to the search,
  and Enter on a top match already on the board.

**The current card's ring was hard to see in some themes (you found it, in XP and 98):** it was a
2 px line in the accent colour drawn just inside the card's edge, so title bars and frames covered
it, and many themes use that same accent for their cards' own frames.
- **Where it's drawn now:** a 3 px ring with a glow, round the card in the gap between cards, on its
  place in the grid (`.grid-stack-item::after`), where nothing of the card can cover it.
- **Its colour (`--ring`) is picked per theme** to differ from the cards' frames: blue in Clean,
  Clean dark and macOS; gold in Aero; XP's orange; yellow with a black edge in 98; magenta in
  Spectrum; hot yellow in Inferno; neon yellow in Neon (its frames are cyan); cyan in Cyberpunk;
  star yellow in Space; green in EVA. It's square in the square themes.
- **Checked in all 12 themes:** each ring differs from its card's frame and stands out from the board
  (from 3.9:1 in Clean up to 18.5:1), and XP and 98 were looked at too.

**Ctrl+C stops Claude (your idea):** a second default key for Stop, beside ⌘. (on a Mac, copy is ⌘C,
so Ctrl+C is free in a write box). With the cursor in a terminal card, every Ctrl key (no Cmd or
Option) goes to the shell, so Ctrl+C keeps stopping what runs there (`isShellKey`, keys.js; the
check in the shortcut listener, board.js), as in iTerm.
- **Four cards without scrolling (Nov 2026).** ⌥⌘ and an arrow used to scroll every card to its top,
  so going between two rows moved the page each time, and a new card (32 rows, 640 px) was too tall
  for two rows to fit on most screens. Now a new card is as tall as lets two rows fit between the
  bars at the top and the status bar (`rowsToFit` in grid.js, measured from the window when the card
  is made; Reset layout uses it too), and the keys scroll only when the card is not wholly on the
  screen, the least way (`landingScroll` in keys.js). A card taller than the screen still lands from
  its top. Cards made before keep their size until resized or Reset layout.
