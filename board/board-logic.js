// What the board computes from the sessions' snapshots: no DOM here, so node can test it.

export const STALE_MS = 30_000
export const LOG_LINES = 15
const PROTECTED_BRANCHES = new Set(['main', 'master'])

export const STATE_LABEL = {
  working: 'WORKING',
  'needs-you': 'NEEDS YOU',
  done: 'DONE',
  stale: 'STALE',
  ended: 'ENDED',
}

/**
 * Modes where a permission prompt is put to the person. In other modes (auto: a classifier decides)
 * an approval counts only once the engine has said its box is in front of the person.
 */
const PERSON_DECIDES = new Set(['default', 'plan', 'acceptEdits'])

const WAIT_LABEL = { approval: 'Needs approval', question: 'Question for you', plan: 'Plan to review' }

/** What the session waits for from the person right now, if anything. */
export function waitingFor(session) {
  const waiting = session.turn?.waiting
  if (waiting && WAIT_LABEL[waiting.kind]) {
    const mode = session.permissionMode
    if (waiting.kind !== 'approval' || waiting.isShown || mode === undefined || PERSON_DECIDES.has(mode)) return waiting
  }
  if (!session.turn?.isRunning && session.turn?.ending === 'question') {
    return { kind: 'question', since: session.turn.endedAt, text: session.turn.question }
  }
  return undefined
}

/**
 * The next-step box a turn closed with, while it waits for the person: its question and the reply
 * buttons it offers. Only for a session that takes messages from CCC and still runs.
 */
export function openNextStep(session) {
  const turn = session?.turn
  if (!turn || turn.isRunning || session.endedAt !== undefined || turn.ending !== 'question' || !session.takesMessages) return null
  const choices = (Array.isArray(turn.choices) ? turn.choices : []).filter(
    choice => typeof choice?.label === 'string' && choice.label.trim() && typeof choice?.message === 'string' && choice.message.trim(),
  )
  return choices.length ? { question: typeof turn.question === 'string' ? turn.question : '', choices } : null
}

/**
 * Whether the board may load its new code by itself now: not while the person writes in it, has a
 * window open or is moving something, since a reload would lose that.
 */
export function mayReloadNow({ isWriting, isWindowOpen, isInteracting }) {
  return !isWriting && !isWindowOpen && !isInteracting
}

/** Where a session started from CCC runs: the Claude app (the default) or a Terminal window. */
export const START_PLACES = ['app', 'terminal']

/** A folder as the start window lists it: its own name, and the folder it sits in. */
export function folderLabel(path) {
  const parts = String(path ?? '').split('/').filter(Boolean)
  const name = parts[parts.length - 1] ?? '/'
  const home = /^\/Users\/[^/]+/.exec(String(path ?? ''))?.[0]
  const parent = '/' + parts.slice(0, -1).join('/')
  return { name, parent: home && parent.startsWith(home) ? `~${parent.slice(home.length)}` : parent }
}

/** Whether a session can be started with what the start window holds, and what it says about it. */
export function startState({ folder, where, isStarting, appName = 'Terminal' }) {
  const place = START_PLACES.includes(where) ? where : 'app'
  const note =
    place === 'app'
      ? 'Opens a new session in the Claude app, in this folder, with your first message already written in it. Press Enter there to send it, and it shows up here. (The app never sends a message by itself.)'
      : `Opens ${appName} in this folder and starts claude with your first message. It shows up here as soon as Claude has it.`
  return { where: place, canStart: Boolean(folder) && !isStarting, note }
}

export const TERMINAL_APPS = ['auto', 'iterm', 'terminal']

export const EDITOR_CHOICES = ['off', 'auto', 'intellij', 'vscode']

/**
 * The editor a click on a step's file opens it in, as { id, name }: null while the setting is off.
 * 'auto' is the editor running (the server picks it); a named one this Mac lacks falls back to it.
 */
export function editorChoice(setting, apps) {
  if (!EDITOR_CHOICES.includes(setting) || setting === 'off') return null
  const known = (Array.isArray(apps) ? apps : []).filter(app => app && typeof app.id === 'string' && typeof app.name === 'string')
  if (known.length === 0) return null
  const named = known.find(app => app.id === setting)
  return named ?? { id: 'auto', name: known.length === 1 ? known[0].name : 'your editor' }
}

export const SETTINGS_TABS = ['look', 'board', 'behaviour', 'terminal']

// wheel events closer together than this are one movement: a push of the wheel and the glide a Mac adds after it
export const WHEEL_GAP_MS = 120
// a glide only slows down; an event this much bigger than the one before is a new push of the wheel
const NEW_PUSH = 4

/** Where no movement has happened yet. */
export const WHEEL_START = { at: -Infinity, mode: null, isDropping: false, size: 0 }

/**
 * Follows the wheel, one movement at a time. A movement goes to the board (Shift held at its start)
 * or to what is under the pointer, and keeps going there; when Shift is pressed or let go in the
 * middle of it, the rest of it is dropped, so nothing scrolls on by itself. A new push of the wheel
 * (bigger than the glide it comes in, or after a pause) starts a new movement.
 * Gives the new state and whether to drop this event.
 */
export function followWheel(state, { now, shiftKey, delta }) {
  const size = Math.abs(delta)
  const isNew = now - state.at > WHEEL_GAP_MS || (state.isDropping && size > state.size + NEW_PUSH)
  let mode = isNew ? null : state.mode
  let isDropping = isNew ? false : state.isDropping
  const wants = shiftKey ? 'page' : 'inside'
  if (!isDropping && mode && mode !== wants) isDropping = true
  if (!isDropping) mode = wants
  return { state: { at: now, mode, isDropping, size }, drop: isDropping }
}

/** A scroll button pressed or let go: a movement still going stops right there. */
export function shiftChanged(state, now) {
  return state.mode && now - state.at <= WHEEL_GAP_MS ? { ...state, isDropping: true } : state
}

/**
 * What one turn of the wheel does with shift-scrolling on: 'page' moves the board (a scroll button
 * held, Shift unless it was removed), 'inside' leaves it to the box under the pointer that can still
 * move that way, 'card' scrolls the chat or terminal the pointer is over (on its header or write box),
 * 'nothing' over the background. The board itself never moves without a scroll button. Windows over
 * the board are left alone.
 */
export function wheelGoes({ isOn, buttonHeld, ctrlKey, inWindow, canScrollInside, inCard }) {
  if (!isOn || ctrlKey || inWindow) return 'default'
  if (buttonHeld) return 'page'
  if (canScrollInside) return 'inside'
  return inCard ? 'card' : 'nothing'
}

// the scroll buttons: with shift-scrolling on, holding one of them with the wheel moves the board.
// Shift is one from the start, either side of it; more can be added and any of them removed. Each kept
// as 'mouse:<event.button>' or 'key:<event.code>' (its event.key when it has no code, as keys sent by a
// mouse's own app can have).
export const SHIFT_BUTTON = 'key:Shift'
export const MAX_SCROLL_BUTTONS = 8
const MOUSE_ID = /^mouse:(\d{1,2})$/
const KEY_ID = /^key:([A-Za-z0-9]{1,32})$/
// the left button clicks and the right one opens menus
const TAKEN_BUTTONS = [0, 2]
// one side of Shift (Shift is kept as one button), Control with the wheel zooms, Escape stops the
// picking, and a key the browser cannot tell apart from others has no name of its own
const TAKEN_KEYS = /^(Shift.|Control|Escape|Unidentified)/
const MOUSE_NAMES = { 1: 'Middle mouse button', 3: 'Mouse button 4 (back)', 4: 'Mouse button 5 (forward)' }
const KEY_NAMES = { AltLeft: 'Left Option', AltRight: 'Right Option', MetaLeft: 'Left Command', MetaRight: 'Right Command', Alt: 'Option', Meta: 'Command' }

/** The scroll button a press is, from { kind: 'mouse', button } or { kind: 'key', code, key }. */
export function scrollButtonOf(press) {
  if (press.kind === 'mouse') return `mouse:${press.button}`
  if (press.key === 'Shift' || /^Shift/.test(press.code ?? '')) return SHIFT_BUTTON
  return `key:${press.code || press.key || ''}`
}

/**
 * Whether one of the scroll `buttons` is held while the wheel turns: one of those `held` down, or
 * Shift, which the wheel event itself tells best.
 */
export function scrollButtonHeld(buttons, { held, shiftKey }) {
  return [...held].some(id => buttons.includes(id)) || Boolean(shiftKey && buttons.includes(SHIFT_BUTTON))
}

/** The scroll buttons as kept, without broken ones or the same one twice; Shift alone when none were kept. */
export function normalizeScrollButtons(value) {
  return Array.isArray(value) ? [...new Set(value.filter(isScrollButton))].slice(0, MAX_SCROLL_BUTTONS) : [SHIFT_BUTTON]
}

/** Whether a kept value is a scroll button that can be used. */
export function isScrollButton(value) {
  if (typeof value !== 'string') return false
  const button = MOUSE_ID.exec(value)?.[1]
  if (button) return !TAKEN_BUTTONS.includes(Number(button))
  const code = KEY_ID.exec(value)?.[1]
  return Boolean(code) && !TAKEN_KEYS.test(code)
}

/**
 * What a press means while a scroll button is being added (a press as `scrollButtonOf` takes it), with
 * the ones already `picked`: { pick } the button to add, { cancel } (Escape), { refuse } with why it
 * cannot be used, or null for a left click, which goes on as a click.
 */
export function scrollButtonPress(press, picked = []) {
  if (press.kind === 'mouse' && press.button === 0) return null
  const id = scrollButtonOf(press)
  if (id === 'key:Escape') return { cancel: true }
  if (picked.includes(id)) return { refuse: `${scrollButtonName(id)} is already added.` }
  if (isScrollButton(id)) return { pick: id }
  if (press.kind === 'mouse') return { refuse: 'The right button opens menus.' }
  if (id.startsWith('key:Control')) return { refuse: 'Control with the wheel zooms.' }
  return { refuse: 'That key cannot be used.' }
}

/** The scroll button as the settings show it, like "Mouse button 4 (back)" or "Left Option". */
export function scrollButtonName(id) {
  if (!isScrollButton(id)) return 'None'
  const button = MOUSE_ID.exec(id)?.[1]
  if (button) return MOUSE_NAMES[button] ?? `Mouse button ${Number(button) + 1}`
  const code = KEY_ID.exec(id)[1]
  return KEY_NAMES[code] ?? code.replace(/^(Key|Digit)(?=.)/, '').replace(/([a-z])([A-Z0-9])/g, '$1 $2')
}

/**
 * The terminal app CCC opens windows in, as { id, name }: the one picked in the settings when this
 * Mac has it, else the first the server found (iTerm when it is installed, else Terminal).
 */
export function terminalApp(picked, apps) {
  const known = (Array.isArray(apps) ? apps : []).filter(app => app && typeof app.id === 'string' && typeof app.name === 'string')
  const list = known.length ? known : [{ id: 'terminal', name: 'Terminal' }]
  return list.find(app => app.id === picked) ?? list[0]
}

/**
 * A terminal card's title: what the shell names its window (the command running, as "vim notes.md"),
 * else its folder's name. A shell's usual "me@my-mac:~/shop" becomes just the folder it is in, "shop".
 */
export function terminalTitle(shellTitle, folder) {
  const said = typeof shellTitle === 'string' ? shellTitle.replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
  if (!said) return folderLabel(folder).name
  const where = /^[^\s@:]+@[^\s:]+:\s*(.+)$/.exec(said)?.[1]
  if (where && /^[~/]/.test(where)) return where === '~' || where === '/' ? where : folderLabel(where).name
  return said.slice(0, 120)
}

/**
 * The folder a shell's window title names, as a full path. Many shells set the title to where they
 * are at every prompt (as ~/code or me@mac:~/code), so a terminal card can follow a cd at once.
 * `knownPath` is a full path of the same person, which says what ~ stands for. Undefined when the
 * title names no folder, as while a command runs.
 */
export function titleFolder(shellTitle, knownPath) {
  const said = typeof shellTitle === 'string' ? shellTitle.replace(/[\u0000-\u001f\u007f]/g, '').trim() : ''
  const where = /^[^\s@:]+@[^\s:]+:\s*(.+)$/.exec(said)?.[1] ?? said
  if (where.startsWith('/')) return where.length > 1 ? where.replace(/\/+$/, '') : where
  const home = /^\/(?:Users|home)\/[^/]+/.exec(String(knownPath ?? ''))?.[0]
  if (home && (where === '~' || where.startsWith('~/'))) return home + where.slice(1).replace(/\/+$/, '')
  return undefined
}

const ANSI = {
  black: '#1d1f21', red: '#e5534b', green: '#57ab5a', yellow: '#c69026', blue: '#539bf5', magenta: '#b083f0', cyan: '#39c5cf', white: '#d0d7de',
  brightBlack: '#636e7b', brightRed: '#ff938a', brightGreen: '#8ddb8c', brightYellow: '#eac55f', brightBlue: '#96d0ff', brightMagenta: '#dcbdfb', brightCyan: '#56d4dd', brightWhite: '#ffffff',
}
const ZX = {
  black: '#000000', red: '#d70000', green: '#00d700', yellow: '#d7d700', blue: '#0000d7', magenta: '#d700d7', cyan: '#00d7d7', white: '#d7d7d7',
  brightBlack: '#555555', brightRed: '#ff0000', brightGreen: '#00ff00', brightYellow: '#ffff00', brightBlue: '#0000ff', brightMagenta: '#ff00ff', brightCyan: '#00ffff', brightWhite: '#ffffff',
}
const MONO = '"IBM Plex Mono", Menlo, Monaco, monospace'
const TERMINAL_LOOKS = {
  aero: { background: '#0b1e33', foreground: '#e6f2ff', cursor: '#5fd3ff', selectionBackground: '#2d6aa066' },
  inferno: { background: '#140404', foreground: '#ffd9c7', cursor: '#ff4b1f', selectionBackground: '#ff4b1f55', red: '#ff3b30', yellow: '#ffb020' },
  neon: { background: '#0d0221', foreground: '#f8f8ff', cursor: '#ff2bd6', selectionBackground: '#ff2bd655', magenta: '#ff2bd6', cyan: '#00f0ff', blue: '#4d7cff' },
  // a netrunner's deck: pale cyan on near black, the HUD's red, yellow and cyan
  cyberpunk: {
    background: '#07090e', foreground: '#d8f6ff', cursor: '#fcee0a', selectionBackground: '#f7504955',
    black: '#1a1d26', red: '#f75049', green: '#3dffb0', yellow: '#fcee0a', blue: '#4d8dff', magenta: '#ff2bd6', cyan: '#5ef6ff', white: '#c8d3e0',
    brightBlack: '#5a6170', brightRed: '#ff7a73', brightGreen: '#7dffcc', brightYellow: '#fff56b', brightBlue: '#80b0ff', brightMagenta: '#ff70e4', brightCyan: '#a4faff', brightWhite: '#ffffff',
  },
  space: { background: '#05070f', foreground: '#cfe3ff', cursor: '#7aa2ff', selectionBackground: '#7aa2ff44' },
  eva: { background: '#120b1c', foreground: '#e8e0ff', cursor: '#ff8a00', selectionBackground: '#9b5cff55', green: '#7cff4f', magenta: '#9b5cff', yellow: '#ff8a00' },
  // the black window of the Command Prompt
  xp: { background: '#000000', foreground: '#c0c0c0', cursor: '#c0c0c0', selectionBackground: '#ffffff55' },
  // the Command Prompt again, in Windows 98's MS-DOS window
  win98: { background: '#000000', foreground: '#c0c0c0', cursor: '#c0c0c0', selectionBackground: '#00008099' },
  // Terminal.app in dark mode: soft white on near black, the system's bright colours
  macos: {
    background: '#1c1c1e', foreground: '#f5f5f7', cursor: '#0a84ff', selectionBackground: '#0a84ff55',
    black: '#3a3a3c', red: '#ff453a', green: '#30d158', yellow: '#ffd60a', blue: '#0a84ff', magenta: '#bf5af2', cyan: '#64d2ff', white: '#d1d1d6',
    brightBlack: '#636366', brightRed: '#ff6961', brightGreen: '#5ee07f', brightYellow: '#ffe066', brightBlue: '#409cff', brightMagenta: '#da8fff', brightCyan: '#8fe0ff', brightWhite: '#ffffff',
  },

  // the eight bright colours, square letters and a flashing block
  spectrum: { ...ZX, background: '#000000', foreground: '#d7d7d7', cursor: '#00d700', selectionBackground: '#0000d7aa' },
  clean: {
    background: '#ffffff', foreground: '#1f2328', cursor: '#1f2328', cursorAccent: '#ffffff', selectionBackground: '#0969da33',
    black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
  },
  // Clean's dark twin: soft grey on near black, colours bright enough to read on it
  'clean-dark': {
    background: '#0f1115', foreground: '#e6e8eb', cursor: '#e6e8eb', selectionBackground: '#6ea8fe44',
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
  },
}

/** How a theme draws its terminals: xterm.js colours, and the font. */
export function terminalLook(themeId) {
  const own = TERMINAL_LOOKS[themeId] ?? TERMINAL_LOOKS.aero
  const isSpectrum = themeId === 'spectrum'
  return {
    theme: { ...(isSpectrum ? ZX : ANSI), cursorAccent: own.background, ...own },
    fontFamily: isSpectrum ? '"Press Start 2P", ' + MONO : MONO,
    fontSize: isSpectrum ? 10 : 13,
    // the square letters need room between their lines
    lineHeight: isSpectrum ? 1.5 : 1.15,
  }
}

export const RUN_LABEL = {
  running: 'working',
  done: 'done',
  failed: 'failed',
  started: 'started',
  proposed: 'proposed',
}

/** Where a session stands: ended, gone quiet, needs the person, working, or done for now. */
export function sessionState(session, now) {
  if (session.endedAt !== undefined) return 'ended'
  if (now - (session.updatedAt ?? 0) > STALE_MS) return 'stale'
  if (waitingFor(session)) return 'needs-you'
  return session.turn?.isRunning ? 'working' : 'done'
}

/**
 * The sessions on the board, in the order they started: a new one lands last and nothing
 * moves while sessions work. Nothing is hidden for its age; the person removes what they are
 * done with. `firstSeen` stands in for a start time an older snapshot lacks; `removing` holds
 * sessions the person just removed, until the server stops sending them.
 */
export function visibleSessions(sessions, now, firstSeen = new Map(), removing = new Set()) {
  const startOf = session =>
    Number.isFinite(session.startedAt) ? session.startedAt : (firstSeen.get(session.sessionId) ?? now)
  return sessions
    .filter(session => !removing.has(session.sessionId) && isWrittenIn(session))
    .sort((a, b) => startOf(a) - startOf(b) || String(a.sessionId).localeCompare(String(b.sessionId)))
}

/**
 * Sessions another session started from its shell (Claude running `claude` itself) are that
 * session's work: they go on its agent map, under the session that began it all, not on cards of
 * their own. One whose parent was removed from the board goes with it; one whose parent is not
 * known at all keeps its card.
 */
export function foldChildren(sessions, hidden = []) {
  const byId = new Map([...hidden, ...sessions].map(session => [session.sessionId, session]))
  // parents that point back at each other (never written by the mod) keep their own cards
  const rootOf = session => {
    let root = session
    const seen = new Set([session.sessionId])
    while (root.parentSessionId && byId.has(root.parentSessionId)) {
      if (seen.has(root.parentSessionId)) return session
      root = byId.get(root.parentSessionId)
      seen.add(root.sessionId)
    }
    return root
  }
  const children = new Map()
  for (const session of sessions) {
    const root = rootOf(session)
    if (root !== session) children.set(session.sessionId, root.sessionId)
  }
  if (children.size === 0) return sessions
  return sessions
    .filter(session => !children.has(session.sessionId))
    .map(session => {
      const mine = sessions.filter(child => children.get(child.sessionId) === session.sessionId)
      return mine.length ? { ...session, runs: [...(session.runs ?? []), ...mine.map(childRun)] } : session
    })
}

/** A child session as a run on its parent's map: working while its turn runs, done after. */
function childRun(child) {
  const isWorking = child.endedAt === undefined && child.turn?.isRunning === true
  const ended = child.endedAt ?? child.turn?.endedAt ?? child.updatedAt
  const last = [...(child.log ?? [])].sort((a, b) => b.at - a.at)[0]
  return {
    id: `session:${child.sessionId}`,
    kind: 'session',
    label: child.turn?.topic || child.folder || 'Session',
    status: isWorking ? 'running' : 'done',
    startedAt: child.startedAt ?? child.turn?.startedAt ?? 0,
    ...(isWorking || !Number.isFinite(ended) ? {} : { endedAt: ended }),
    lastAction: last?.text ?? 'session Claude started',
  }
}

/**
 * The sessions that have just come onto the board: on it now, not the last time it was drawn.
 * Before the board's first drawing (`onBoard` null) nobody arrives, so loading the page or
 * changing the theme plays no arrival.
 */
export function arrivals(onBoard, ids) {
  if (!onBoard) return []
  return ids.filter(id => !onBoard.has(id))
}

const SOURCES = {
  'claude-desktop': { kind: 'app', label: 'Claude app', about: 'Started in the Claude app' },
  'claude-vscode': { kind: 'vscode', label: 'VS Code', about: 'Started in VS Code' },
  cli: { kind: 'terminal', label: 'Terminal', about: 'Started in a terminal' },
}

/** Where a session runs: the Claude app, VS Code or a terminal; nothing for a place the board does not know. */
export function sourceOf(session) {
  return SOURCES[session?.entrypoint] ?? null
}

const APP_SESSION_ID = /^local_[A-Za-z0-9-]{1,64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Where the card's Open button goes: the chat in the Claude app when the app holds the session,
 * else the chat in VS Code for a session that runs there. A terminal has no way in, so nothing.
 */
export function openLink(session) {
  if (APP_SESSION_ID.test(session?.appSessionId ?? '')) {
    return { href: `claude://code/continue?session=${session.appSessionId}`, about: 'Open this chat in the Claude app' }
  }
  if (session?.entrypoint === 'claude-vscode' && UUID.test(session.sessionId ?? '')) {
    return { href: `vscode://anthropic.claude-code/open?session=${session.sessionId}`, about: 'Open this chat in VS Code' }
  }
  return null
}

/** Why a session's context cannot be cleared from CCC, or '' when it can. */
export function endProblem(session) {
  if (!session) return 'This session is no longer on the board.'
  if (!session.takesMessages) return 'This session runs an older CCC, so CCC cannot clear it. Close it from CCC, and clear it where it runs.'
  if (session.endedAt !== undefined) return 'This session is not running, so there is nothing to clear. Close it from CCC.'
  return ''
}

/** The conversations whose name or folder holds every word searched for. */
export function matchConversations(conversations, search) {
  const words = String(search ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const list = Array.isArray(conversations) ? conversations : []
  return list.filter(conversation => {
    const text = `${conversation?.title ?? ''} ${conversation?.folder ?? ''}`.toLowerCase()
    return words.every(word => text.includes(word))
  })
}

/** How long ago a time was, the short way: just now, 5 min ago, 3 h ago, 2 days ago. */
export function timeAgo(at, now) {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  const days = Math.floor(seconds / 86400)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/** A chat only opened in the app, never written in, is no work of the day and stays off the board. */
function isWrittenIn(session) {
  return Number.isFinite(session.turn?.startedAt)
}

/** The local calendar day of a moment, as YYYY-MM-DD (the mod writes the same). */
export function dayOf(ms) {
  const at = new Date(ms)
  const pad = part => String(part).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** What a session has cost on `day`; nothing when its snapshot speaks of another day. */
export function spentOn(session, day) {
  const today = session.today
  return today && today.day === day && Number.isFinite(today.usd) ? today.usd : 0
}

/** What every session, closed ones included, has cost on `day`. */
export function totalOn(sessions, day) {
  return sessions.reduce((sum, session) => sum + spentOn(session, day), 0)
}

/** The numbers across the top: counts, total cost and the account's limits. */
export function summarize(sessions, now) {
  const states = sessions.map(session => sessionState(session, now))
  const live = sessions.filter((_, i) => ['working', 'needs-you', 'done'].includes(states[i]))

  return {
    live: live.length,
    working: states.filter(state => state === 'working').length,
    needsYou: states.filter(state => state === 'needs-you').length,
    done: states.filter(state => state === 'done').length,
    agentsRunning: live.reduce((sum, session) => sum + runningRuns(session).length, 0),
  }
}

/**
 * A session's runs in the order the map draws them: each run the session started, and right
 * under a workflow the agents it runs. A workflow shows as working while any of its agents
 * works, and as done once all of them are; an agent whose workflow is unknown stands alone.
 */
export function mapRows(runs) {
  const list = runs ?? []
  const ids = new Set(list.map(run => run.id))
  const isChild = run => Boolean(run.parentId) && ids.has(run.parentId)
  return list
    .filter(run => !isChild(run))
    .flatMap(run => {
      const agents = list.filter(one => one.parentId === run.id)
      return [
        { run, depth: 0, status: shownStatus(run, agents), agents: agents.length, working: agents.filter(one => one.status === 'running').length },
        ...agents.map(agent => ({ run: agent, depth: 1, status: agent.status, agents: 0, working: 0 })),
      ]
    })
}

/**
 * An agent's steps as the board shows them: numbered from the agent's first, the latest last, with
 * how many earlier ones the session no longer keeps.
 */
export function agentSteps(run) {
  const steps = (Array.isArray(run?.steps) ? run.steps : []).filter(step => typeof step?.text === 'string' && Number.isFinite(step?.at))
  const count = Math.max(steps.length, Number.isFinite(run?.stepCount) ? run.stepCount : 0)
  const first = count - steps.length + 1
  return { count, earlier: count - steps.length, steps: steps.map((step, i) => ({ ...step, number: first + i })) }
}

/** An agent's own task list, when it keeps one, without empty steps. */
export function agentPlan(run) {
  return (Array.isArray(run?.plan) ? run.plan : []).filter(step => typeof step?.text === 'string' && step.text.trim() !== '')
}

const PLAN_MARK = { completed: 'ok', in_progress: 'running' }

/**
 * The small boxes after an agent in the map, as many as `room` holds. An agent with a task list of
 * its own shows its planned steps, done and to come, around the one it works on; any other shows
 * its latest tool calls, the newest last. With how many more there are before and after.
 */
export function stepNodes(run, room) {
  const most = Math.max(0, Math.floor(room))
  const plan = agentPlan(run)
  if (plan.length > 0) {
    const nodes = plan.map((step, i) => ({ kind: 'plan', number: i + 1, text: step.text.trim(), status: PLAN_MARK[step.status] ?? 'pending' }))
    const current = plan.findIndex(step => step.status === 'in_progress')
    const pending = plan.findIndex(step => step.status === 'pending')
    const focus = current !== -1 ? current : pending !== -1 ? pending : plan.length - 1
    // the step before the one at work stays in view, so the move from one to the next shows
    const start = Math.max(0, Math.min(focus - 1, plan.length - most))
    const shown = nodes.slice(start, start + most)
    return { nodes: shown, earlier: start, later: Math.max(0, plan.length - start - shown.length) }
  }
  const { count, steps } = agentSteps(run)
  const shown = most > 0 ? steps.slice(-most) : []
  const nodes = shown.map(step => ({ kind: 'step', number: step.number, text: step.text, status: step.status === 'ok' || step.status === 'error' ? step.status : 'running' }))
  return { nodes, earlier: count - nodes.length, later: 0 }
}

/** A step's words split for its small box: what it does ("Read", "$"), and on what. */
export function stepWords(text) {
  const words = String(text ?? '').trim()
  const match = /^(\$|[A-Za-z][\w-]*:?)\s+(.+)$/.exec(words)
  return match ? { verb: match[1].replace(/:$/, ''), rest: match[2] } : { verb: words, rest: '' }
}

/**
 * The runs the board still shows once the person cleared the finished ones. Everything that is
 * not working at that moment goes: done or failed runs, session cards, and runs left standing as
 * started that nothing reports on any more (a workflow seen by an older mod). A workflow with an
 * agent at work stays, and whatever starts later shows as usual.
 */
export function shownRuns(runs, clearedAt) {
  const list = runs ?? []
  if (!Number.isFinite(clearedAt) || clearedAt <= 0) return list
  const gone = new Set()
  for (const { run, status } of mapRows(list)) {
    if (status !== 'running' && endOf(run, list) <= clearedAt) gone.add(run.id)
  }
  return list.filter(run => !gone.has(run.id) && !(run.parentId && gone.has(run.parentId) && run.status !== 'running'))
}

/** When a run ended: its own end, else its last agent's, else when it started. */
function endOf(run, list) {
  if (Number.isFinite(run.endedAt)) return run.endedAt
  const ends = list.filter(one => one.parentId === run.id && Number.isFinite(one.endedAt)).map(one => one.endedAt)
  return ends.length ? Math.max(...ends) : (run.startedAt ?? 0)
}

function shownStatus(run, agents) {
  if (run.kind !== 'workflow' || agents.length === 0 || run.status === 'failed') return run.status
  return agents.some(agent => agent.status === 'running') ? 'running' : 'done'
}

export function runningRuns(session) {
  return (session.runs ?? []).filter(run => run.status === 'running')
}

export const LABEL_MAX = 34

/** A session's name: the one the Claude app shows, else the start of its first prompt, else its folder. */
export function sessionLabel(session) {
  const title = String(session.title ?? '').trim()
  if (title) return title.length <= LABEL_MAX ? title : `${title.slice(0, LABEL_MAX - 1).trimEnd()}…`
  const topic = String(session.turn?.topic ?? '').trim()
  if (!topic) return String(session.folder ?? 'Session')
  if (topic.length <= LABEL_MAX) return topic
  const cut = topic.slice(0, LABEL_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > LABEL_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** A short name per session, with an id suffix where two would read the same. */
export function sessionTags(sessions) {
  const counts = new Map()
  for (const session of sessions) {
    const label = sessionLabel(session)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return new Map(
    sessions.map(session => {
      const label = sessionLabel(session)
      return [session.sessionId, counts.get(label) > 1 ? `${label} ·${String(session.sessionId).slice(0, 4)}` : label]
    }),
  )
}

/** A session's own log, newest first. */
export function recentLog(session, max = LOG_LINES) {
  return [...(session.log ?? [])].sort((a, b) => b.at - a.at).slice(0, max)
}

const REPLY_SHOWN = 3000

/**
 * What a card shows of Claude's latest reply: its plain text and how it stands; `thinking` is a
 * turn that has not written anything yet. A session on an older mod has no live reply, so its
 * chat's latest answer stands in, as a big card shows it.
 */
export function liveReply(session) {
  const isRunning = Boolean(session?.turn?.isRunning)
  const text = session && 'reply' in session ? plainReply(session.reply?.text) : plainReply(latestAnswer(session))
  if (text) return { state: session.reply?.isWriting && isRunning ? 'writing' : 'written', text }
  return { state: isRunning ? 'thinking' : 'empty', text: '' }
}

/**
 * While a turn runs, the answer Claude gave before it, so the reply box keeps what was said and
 * the new text follows on under it. Nothing once the turn is over: its own answer then stands.
 */
export function earlierAnswer(session) {
  if (!session?.turn?.isRunning) return ''
  const chat = session.chat ?? []
  const last = chat[chat.length - 1]
  const finished = last && last.answer === undefined && last.endedAt === undefined ? chat.slice(0, -1) : chat
  const before = [...finished].reverse().find(turn => turn.answer)
  return before ? plainReply(before.answer) : ''
}

/** The answer of the chat's latest exchange; none while that exchange is still going. */
function latestAnswer(session) {
  const chat = session?.chat ?? []
  return chat.length ? chat[chat.length - 1].answer : undefined
}

/** Claude's markdown as plain lines: no code fences, heading marks, bold or backticks, no blank runs; its end only. */
export function plainReply(markdown) {
  const text = String(markdown ?? '')
    .split('\n')
    .filter(line => !/^\s*```/.test(line))
    .map(line => line.replace(/^\s*#{1,6}\s+/, '').replace(/\*\*|__|`/g, '').replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return text.length <= REPLY_SHOWN ? text : text.slice(-REPLY_SHOWN).replace(/^\S*\s/, '')
}

/** Within this many pixels of the end, a scroll box counts as at its newest line. */
const BOTTOM_SLACK = 6

/** Whether a scroll box shows its newest line. */
export function isAtBottom({ scrollHeight, scrollTop, clientHeight }) {
  return scrollHeight - scrollTop - clientHeight < BOTTOM_SLACK
}

/** Where a redrawn scroll box goes: where the person left it if they scrolled up, else to its newest line. */
export function scrollAfterRedraw(kept, scrollHeight) {
  return kept && !kept.isAtBottom ? kept.top : scrollHeight
}

/** A card's live terminal: always `rows` lines, oldest at the top, newest at the bottom; `null` is an empty line above them. */
export function terminalLines(session, rows) {
  const count = Math.max(0, Math.floor(Number(rows) || 0))
  const entries = recentLog(session, count).reverse()
  return [...Array(count - entries.length).fill(null), ...entries]
}

/** A model id as people say it: `claude-opus-5-5[1m]` is "Opus 5.5 · 1M". */
export function modelName(id) {
  const raw = String(id ?? '').trim()
  if (!raw) return ''
  const isLong = /\[1m\]$/i.test(raw)
  const base = raw.replace(/\[1m\]$/i, '').replace(/^claude-/, '').replace(/-\d{8}$/, '')
  const match = /^([a-z]+)-(\d+)(?:-(\d+))?$/.exec(base)
  if (!match) return raw
  const [, family, major, minor] = match
  const name = `${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}`
  return isLong ? `${name} · 1M` : name
}

export function planProgress(plan) {
  const steps = plan ?? []
  const done = steps.filter(step => step.status === 'completed').length
  const current = steps.find(step => step.status === 'in_progress')
  return { done, total: steps.length, current: current?.text }
}

export function isProtectedBranch(branch) {
  return PROTECTED_BRANCHES.has(branch)
}

export function limitName(kind) {
  if (kind === 'five_hour') return '5H'
  if (kind === 'seven_day') return 'WEEK'
  return String(kind).replace(/_/g, ' ').toUpperCase()
}

export function usd(amount) {
  return `$${(finite(amount) ?? 0).toFixed(2)}`
}

export function tokens(count) {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`
  if (count >= 1_000_000) return `${trim(count / 1_000_000)}M`
  if (count >= 1_000) return `${trim(count / 1_000)}k`
  return String(count ?? 0)
}

export function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

export function clock(ms) {
  const at = new Date(ms)
  return [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map(part => String(part).padStart(2, '0'))
    .join(':')
}

export function clamp01(value) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}

function finite(value) {
  return Number.isFinite(value) ? value : undefined
}

function trim(value) {
  return value.toFixed(1).replace(/\.0$/, '')
}

// ---------- Aero board: identity colours, rings, tool mix ----------

/**
 * Each session's own colour, handed out in this order: blue, orange, green, violet, pink, teal, gold,
 * red, lime, brown. Every pair stays clearly apart side by side. Grey is for sessions past the tenth.
 */
export const IDENTITY = ['#2a78d6', '#eb6834', '#1baf7a', '#8b5cf6', '#e0449a', '#14b8c4', '#d4a017', '#b3122e', '#7cb518', '#8a5a2b']
export const OTHER_COLOR = '#8aa4bd'

/** Gives each visible session a colour slot that it keeps while it stays visible. */
export function assignSlots(previous, sessionIds) {
  const visible = new Set(sessionIds)
  const slots = new Map([...previous].filter(([id]) => visible.has(id)))
  const taken = new Set(slots.values())
  for (const id of sessionIds) {
    if (slots.has(id)) continue
    const free = IDENTITY.findIndex((_, slot) => !taken.has(slot))
    if (free === -1) continue
    slots.set(id, free)
    taken.add(free)
  }
  return slots
}

export function identityColor(slots, sessionId) {
  const slot = slots.get(sessionId)
  return slot === undefined ? OTHER_COLOR : IDENTITY[slot]
}

/**
 * Where each session sits round the radar, in degrees clockwise from twelve o'clock. A session
 * keeps its place while it stays, so dots never jump; a new one goes to the middle of the widest
 * gap between the others.
 */
export function radarAngles(previous, ids) {
  const angles = new Map([...previous].filter(([id]) => ids.includes(id)))
  for (const id of ids) {
    if (!angles.has(id)) angles.set(id, widestGapMiddle([...angles.values()]))
  }
  return angles
}

function widestGapMiddle(taken) {
  if (taken.length === 0) return 0
  const sorted = [...taken].sort((a, b) => a - b)
  // the gap that runs past twelve o'clock, from the last angle round to the first
  let from = sorted[sorted.length - 1]
  let size = sorted[0] + 360 - from
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] > size) {
      from = sorted[i - 1]
      size = sorted[i] - sorted[i - 1]
    }
  }
  return (from + size / 2) % 360
}

/** How many sessions wait for the person, in words for the radar's title: '' when none. */
export function waitingCount(states) {
  const count = states.filter(state => state === 'needs-you').length
  return count === 0 ? '' : `${count} ${count === 1 ? 'needs' : 'need'} you`
}

/** `stroke-dasharray` for a ring filled to `percent`. */
export function ringDash(percent, radius) {
  const length = 2 * Math.PI * radius
  const filled = clamp01(percent / 100) * length
  return `${filled.toFixed(1)} ${(length - filled).toFixed(1)}`
}

/** Donut segments for the values, a small gap between them, starting at twelve o'clock. */
export function donutSegments(items, radius, gap = 4) {
  const length = 2 * Math.PI * radius
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0)
  if (total <= 0) return []
  let start = 0
  return items
    .filter(item => item.value > 0)
    .map(item => {
      const share = item.value / total
      const span = share * length
      const drawn = Math.max(0, span - (items.length > 1 ? gap : 0))
      const segment = {
        ...item,
        share,
        dash: `${drawn.toFixed(1)} ${(length - drawn).toFixed(1)}`,
        offset: (-start).toFixed(1),
      }
      start += span
      return segment
    })
}

/** What the prompts today came to, for the header's hover text: each session on the board, then the rest. */
export function promptSummary(prompts, tags) {
  const total = Math.max(0, finite(prompts?.total) ?? 0)
  const shown = []
  let other = 0
  for (const [id, count] of Object.entries(prompts?.bySession ?? {}).sort((a, b) => b[1] - a[1])) {
    if (!(Number.isFinite(count) && count > 0)) continue
    if (tags.has(id)) shown.push(`${tags.get(id)} ${count}`)
    else other += count
  }
  const parts = [...shown, ...(other > 0 ? [`other sessions ${other}`] : [])]
  return `${total} prompt${total === 1 ? '' : 's'} you wrote today${parts.length ? `: ${parts.join(', ')}` : ''}`
}

/** Calls per tool kind across the sessions, most used first. */
export function toolMix(sessions, max = 6) {
  const counts = new Map()
  for (const session of sessions) {
    for (const [kind, count] of Object.entries(session.tools ?? {})) {
      if (Number.isFinite(count) && count > 0) counts.set(kind, (counts.get(kind) ?? 0) + count)
    }
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, max)
}

/** How far into the local day a time is, from 0 at midnight to 1 at the next. */
export function dayFraction(ms) {
  const at = new Date(ms)
  return clamp01((at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60) / 1440)
}

/** The running total at the end of each hour of a day's 24 hourly counts. */
export function runningTotals(hours) {
  let sum = 0
  return Array.from({ length: 24 }, (_, i) => (sum += Math.max(0, finite(hours?.[i]) ?? 0)))
}

/** The token graph in a width × height box: today's running total up to now, a line and the area under it. */
export function tokenPaths(hours, now, width, height) {
  const today = runningTotals(hours)
  const at = dayFraction(now)
  const hour = Math.min(23, Math.floor(at * 24))
  const top = Math.max(1, today[hour])
  const y = value => (height - 2 - (value / top) * (height - 4)).toFixed(1)
  const x = fraction => (fraction * width).toFixed(1)
  const points = [[x(0), y(0)], ...today.slice(0, hour).map((value, i) => [x((i + 1) / 24), y(value)]), [x(at), y(today[hour])]]
  const line = points.map(([px, py], i) => `${i ? 'L' : 'M'}${px} ${py}`).join(' ')
  return { line, area: `${line} L${x(at)} ${height} L0 ${height} Z` }
}

// ---------- the token history window ----------

export const TOKEN_PERIODS = [
  { id: 'today', days: 1, label: 'Today' },
  { id: '7', days: 7, label: 'Last 7 days' },
  { id: '14', days: 14, label: 'Last 14 days' },
  { id: '30', days: 30, label: 'Last 30 days' },
  { id: '90', days: 90, label: 'Last 90 days' },
]

export const TOKEN_KINDS = [
  { key: 'total', label: 'Total', note: 'all tokens' },
  { key: 'output', label: 'Output', note: 'what Claude wrote' },
  { key: 'input', label: 'Input', note: 'new text Claude read' },
  { key: 'cached', label: 'Cached', note: 'the conversation read again' },
]

/** The period the person picked, or a week when the choice is unknown. */
export function tokenPeriod(id) {
  return TOKEN_PERIODS.find(period => period.id === id) ?? TOKEN_PERIODS[1]
}

/** The kind of tokens the person picked, or the total when the choice is unknown. */
export function tokenKind(key) {
  return TOKEN_KINDS.find(kind => kind.key === key) ?? TOKEN_KINDS[0]
}

/**
 * One kind over the period, a point a day with today last, or a point an hour over the whole of
 * today with the hours to come marked. The point for now (today, this hour) is not over yet.
 */
export function historySeries(history, periodId, kind) {
  const count = value => Math.max(0, finite(value) ?? 0)
  if (periodId === 'today') {
    const hour = Math.min(23, Math.max(0, finite(history?.hour) ?? 23))
    return (history?.hours ?? []).map((row, i) => ({ label: `${String(i).padStart(2, '0')}:00`, value: count(row?.[kind]), isNow: i === hour, isToCome: i > hour }))
  }
  const days = history?.days ?? []
  return days.map((row, i) => ({ label: shortDay(row?.day), day: row?.day, value: count(row?.[kind]), isNow: i === days.length - 1 }))
}

/** What each kind came to over the period, and its share of all tokens. */
export function historyTotals(history, periodId) {
  const sums = Object.fromEntries(TOKEN_KINDS.map(({ key }) => [key, historySeries(history, periodId, key).reduce((total, item) => total + item.value, 0)]))
  return Object.fromEntries(TOKEN_KINDS.map(({ key }) => [key, { sum: sums[key], share: sums.total > 0 ? sums[key] / sums.total : 0 }]))
}

/**
 * The figures under one kind's graph: its average a day (an hour for today) over the days the
 * transcripts still cover, its busiest day or hour, and how far now has got.
 */
export function historyStats(history, periodId, kind) {
  const series = historySeries(history, periodId, kind).filter(item => !item.isToCome)
  const first = history?.firstDay
  const covered = periodId === 'today' || !first ? series : series.filter(item => !item.day || item.day >= first)
  const sum = series.reduce((total, item) => total + item.value, 0)
  const peak = series.reduce((best, item) => (item.value > (best?.value ?? 0) ? item : best), null)
  return {
    average: covered.length ? sum / covered.length : 0,
    spanned: covered.length,
    peak: peak ? { label: peak.label, value: peak.value } : null,
    now: series.find(item => item.isNow)?.value ?? 0,
  }
}

/** A kind's share of all tokens in words, never rounded down to nothing when it had some. */
export function shareOfAll(share) {
  if (!(share > 0)) return '0% of all'
  if (share < 0.01) return 'under 1% of all'
  return `${Math.round(share * 100)}% of all`
}

/** A value axis from 0 up past `top`, in about `count` even steps of 1, 2, 2.5 or 5 times a power of ten. */
export function niceScale(top, count = 4) {
  if (!(top > 0)) return { max: 0, ticks: [0] }
  const rough = top / count
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * power).find(candidate => candidate >= rough)
  const steps = Math.ceil(top / step - 1e-9)
  return { max: steps * step, ticks: Array.from({ length: steps + 1 }, (_, i) => Number((i * step).toPrecision(12))) }
}

/** Where each point of a series lies in a width × height box, spread evenly, 0 on the bottom edge. */
export function linePoints(values, width, height, max) {
  const step = values.length > 1 ? width / (values.length - 1) : 0
  return values.map((value, i) => ({ x: values.length > 1 ? i * step : width / 2, y: max > 0 ? height - (Math.max(0, value) / max) * height : height }))
}

/** A line through points, and the area under it down to `bottom`. */
export function linePath(points, bottom) {
  if (points.length === 0) return { line: '', area: '' }
  const n = value => Number(value.toFixed(1))
  const line = points.map((point, i) => `${i ? 'L' : 'M'}${n(point.x)} ${n(point.y)}`).join(' ')
  const last = points[points.length - 1]
  return { line, area: `${line} L${n(last.x)} ${n(bottom)} L${n(points[0].x)} ${n(bottom)} Z` }
}

/**
 * The points named under the graph: every sixth hour for today; else days evenly apart, at most
 * `room` of them and never more than seven or eight, the first and the last always among them.
 */
export function axisTicks(series, periodId, room = 8) {
  if (series.length === 0) return []
  const pick = indices => indices.map(index => ({ index, label: series[index].label }))
  if (periodId === 'today') return pick([0, 6, 12, 18, 23].filter(index => index < series.length))
  const most = Math.max(2, Math.min(8, Math.floor(room)))
  if (series.length <= most) return pick(series.map((_, i) => i))
  const last = series.length - 1
  const step = Math.ceil(last / (Math.min(most, 7) - 1))
  const indices = []
  for (let index = 0; index < last; index += step) indices.push(index)
  // the last label stands left of its day, so the one before it needs a good stretch of room
  if (last - indices[indices.length - 1] < step * 0.75) indices.pop()
  return pick([...indices, last])
}

/** The point nearest to `x` in a graph `width` wide of `count` points, never one past `lastShown`. */
export function nearestPoint(x, width, count, lastShown = count - 1) {
  if (count <= 1) return 0
  return Math.min(lastShown, Math.max(0, Math.round((x / Math.max(1, width)) * (count - 1))))
}

/** A day as `14 Oct`, read in local time. */
export function shortDay(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''))
  if (!match) return ''
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** What the window says when the period reaches further back than any transcript Claude Code kept. */
export function historyNote(history, periodId) {
  const first = history?.firstDay
  const start = history?.days?.[0]?.day
  if (periodId === 'today' || !first || !start || first <= start) return ''
  return `Transcripts go back to ${shortDay(first)}. Claude Code clears older ones, so the days before show nothing.`
}

/** What one hour of today's graph says: that hour's tokens and the total by then; nothing for hours to come. */
export function tokenHour(hours, index, now) {
  const hour = Math.min(23, Math.max(0, Math.floor(index)))
  const current = Math.min(23, Math.floor(dayFraction(now) * 24))
  const label = `${String(hour).padStart(2, '0')}:00–${String((hour + 1) % 24).padStart(2, '0')}:00`
  if (hour > current) return { hour, label }
  return { hour, label, used: Math.max(0, finite(hours?.[hour]) ?? 0), soFar: runningTotals(hours)[hour] }
}

// ---------- live status, layout and settings ----------

/**
 * What a session is doing right now and since when: running a tool, thinking between tools,
 * waiting for the person, gone quiet or ended.
 */
export function activityOf(session, now) {
  const state = sessionState(session, now)
  if (state === 'ended') return { kind: 'ended', label: 'Ended', since: session.endedAt }
  if (state === 'stale') return { kind: 'stale', label: 'No word from it', since: session.updatedAt }
  const log = [...(session.log ?? [])].sort((a, b) => b.at - a.at)
  const waiting = waitingFor(session)
  if (waiting) {
    return { kind: waiting.kind, label: WAIT_LABEL[waiting.kind], since: waiting.since, ...(waiting.text ? { text: waiting.text } : {}) }
  }
  if (state === 'done') {
    return { kind: 'done', label: 'Done', since: session.turn?.endedAt ?? log[0]?.endedAt ?? log[0]?.at }
  }
  const running = log.find(entry => entry.status === 'running')
  if (running) return { kind: 'tool', label: 'Running', since: running.at, text: running.text }
  const turnStart = session.turn?.startedAt ?? 0
  const lastEnd = log.find(entry => entry.endedAt !== undefined && entry.endedAt >= turnStart)?.endedAt
  return { kind: 'thinking', label: 'Thinking', since: lastEnd ?? session.turn?.startedAt }
}

/** Saved order first, sessions never placed by hand after them in the order they started. */
export function arrangeSessions(sessions, order) {
  const index = new Map(order.map((id, i) => [id, i]))
  const placed = sessions.filter(s => index.has(s.sessionId)).sort((a, b) => index.get(a.sessionId) - index.get(b.sessionId))
  return [...placed, ...sessions.filter(s => !index.has(s.sessionId))]
}

/** The sizes of cards and of the chats they open into, in the board's own pixels. */
export const CARD_WIDTH = 300
export const LARGE_CARD_WIDTH = 612
export const CARD_MIN_WIDTH = 260
export const CARD_MIN_HEIGHT = 80
export const CHAT_WIDTH = 612
export const CHAT_MIN_WIDTH = 380
export const CHAT_HEIGHT = 640
export const CHAT_MIN_HEIGHT = 360
/** A column of the grid the board had before cards were placed freely: what a kept `cols` was worth. */
const OLD_COLUMN = 146

/**
 * How much a grip pulled by (dx, dy) makes its card wider and taller. The right edge, the bottom edge
 * and their corner grow as pulled; a left or top edge or corner grows when pulled away from the card,
 * since the card keeps its place in the grid and grows from there.
 */
export function gripGrowth(axis, dx, dy) {
  const sides = {
    x: [1, 0],
    left: [-1, 0],
    y: [0, 1],
    top: [0, -1],
    'corner-tl': [-1, -1],
    'corner-tr': [1, -1],
    'corner-bl': [-1, 1],
  }
  const [width, height] = sides[axis] ?? [1, 1]
  return { width: width * dx, height: height * dy }
}

/** Which sides of a card a grip moves. */
export function gripSides(axis) {
  return {
    left: axis === 'left' || axis === 'corner-tl' || axis === 'corner-bl',
    right: axis === 'x' || axis === 'corner-tr' || axis === undefined || axis === '' || axis === 'corner',
    top: axis === 'top' || axis === 'corner-tl' || axis === 'corner-tr',
    bottom: axis === 'y' || axis === 'corner-bl' || axis === undefined || axis === '' || axis === 'corner',
  }
}

/** A small card's width: its own, else one card wide (two when cards are large). */
export function cardWidth(card, isLargeSize) {
  if (Number.isFinite(card?.w)) return Math.max(CARD_MIN_WIDTH, card.w)
  return isLargeSize && !card?.collapsed ? LARGE_CARD_WIDTH : CARD_WIDTH
}

/** An open chat's width and height, from what was kept for it; its panel of facts opens inside it. */
export function chatBox(size) {
  return {
    w: Math.max(CHAT_MIN_WIDTH, Number.isFinite(size?.w) ? size.w : CHAT_WIDTH),
    h: Math.max(CHAT_MIN_HEIGHT, Number.isFinite(size?.height) ? size.height : CHAT_HEIGHT),
  }
}

export const THEME_IDS = ['clean', 'clean-dark', 'macos', 'aero', 'xp', 'win98', 'spectrum', 'inferno', 'neon', 'cyberpunk', 'space', 'eva']
export const WOBBLE_MODES = ['aero', 'always', 'never']
export const CARD_SIZES = ['compact', 'large']

/** Settings as stored, with anything missing or broken put back to its default. */
export function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  return {
    theme: THEME_IDS.includes(value.theme) ? value.theme : 'clean',
    animations: typeof value.animations === 'boolean' ? value.animations : true,
    wobble: WOBBLE_MODES.includes(value.wobble) ? value.wobble : 'aero',
    cardSize: CARD_SIZES.includes(value.cardSize) ? value.cardSize : 'compact',
    // whether the board holds still while its window is in the background; it keeps moving unless asked
    freeze: typeof value.freeze === 'boolean' ? value.freeze : false,
    // the status bar along the bottom (limits, spend, agents), on unless the person turns it off
    statusBar: typeof value.statusBar === 'boolean' ? value.statusBar : true,
    // the column at the right (the radar, the tool mix, the notes), on unless the person turns it off
    sidePanel: typeof value.sidePanel === 'boolean' ? value.sidePanel : true,
    // the wheel moves only what is under the pointer, and Shift with the wheel moves the board; off unless turned on
    shiftScroll: typeof value.shiftScroll === 'boolean' ? value.shiftScroll : false,
    // with shift-scrolling on, the buttons that move the board while held: Shift unless the person changes them
    scrollButtons: normalizeScrollButtons(value.scrollButtons),
    // Claude's short notes between steps, shown as the Claude app shows them, unless the person hides them
    showNotes: typeof value.showNotes === 'boolean' ? value.showNotes : true,
    // the app CCC opens terminal windows in: iTerm when this Mac has it, unless the person picks one
    terminalApp: TERMINAL_APPS.includes(value.terminalApp) ? value.terminalApp : 'auto',
    // file names in opened steps open the file in this editor; off unless the person turns it on
    editor: EDITOR_CHOICES.includes(value.editor) ? value.editor : 'off',
  }
}

export function wobbles(settings) {
  if (!settings.animations || settings.wobble === 'never') return false
  return settings.wobble === 'always' || settings.theme === 'aero'
}

const MAX_IDS = 500

/** The layout as stored (order, card and panel sizes), keeping only what makes sense. */
export function normalizeLayout(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  return {
    order: ids(value.order),
    panelOrder: ids(value.panelOrder),
    // a card's place and width; widths kept in the grid's columns before (`cols`, before that whole
    // cards as `span`) become pixels
    cards: sizes(value.cards, size => ({
      ...(inRange(size.x, 0, 100000) && inRange(size.y, 0, 100000) ? { x: Math.round(size.x), y: Math.round(size.y) } : {}),
      ...(keptWidth(size) ? { w: keptWidth(size) } : {}),
      ...(inRange(size.minHeight, 80, 3000) ? { minHeight: Math.round(size.minHeight) } : {}),
      ...(size.collapsed === true ? { collapsed: true } : {}),
    })),
    ...(inRange(value.sidebarWidth, 260, 900) ? { sidebarWidth: Math.round(value.sidebarWidth) } : {}),
    ...(Number.isFinite(value.runsClearedAt) && value.runsClearedAt > 0 ? { runsClearedAt: value.runsClearedAt } : {}),
    open: ids(value.open),
    chats: sizes(value.chats, size => ({
      ...(keptWidth(size, 6) ? { w: keptWidth(size, 6) } : {}),
      ...(inRange(size.height, 300, 4000) ? { height: Math.round(size.height) } : {}),
      ...(size.showSide === true ? { showSide: true } : {}),
    })),
    panels: sizes(value.panels, size => ({
      ...(inRange(size.basis, 200, 4000) ? { basis: Math.round(size.basis) } : {}),
      ...(inRange(size.minHeight, 80, 3000) ? { minHeight: Math.round(size.minHeight) } : {}),
    })),
  }
}

/** A width kept for a card or a chat, in pixels, from any of the shapes it was kept in. */
function keptWidth(size, maxSpan = 3) {
  if (inRange(size.w, 120, 8000)) return Math.round(size.w)
  if (inRange(size.cols, 1, 24)) return Math.round(size.cols) * OLD_COLUMN - 12
  if (inRange(size.span, 1, maxSpan)) return Math.round(size.span) * 2 * OLD_COLUMN - 12
  return 0
}

function ids(list) {
  if (!Array.isArray(list)) return []
  return [...new Set(list.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 128))].slice(0, MAX_IDS)
}

function sizes(map, read) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {}
  const out = {}
  for (const [id, size] of Object.entries(map).slice(0, MAX_IDS)) {
    if (id.length > 128 || !size || typeof size !== 'object') continue
    const clean = read(size)
    if (Object.keys(clean).length > 0) out[id] = clean
  }
  return out
}

/**
 * How much the board shrinks for a window `width` px wide: gently, so a wider window always
 * gives the cards more room (at 900 px the board is drawn at 72 %, from 1600 px at full size).
 */
export function scaleFor(width) {
  return Math.min(1, Math.max(0.72, 0.72 + (width - 900) * 0.0004))
}

/** Grid columns a card takes: its own size, one more when made big, never more than the grid has. */
function inRange(value, low, high) {
  return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high
}


// ---------- usage limits ----------

const LIMIT_ORDER = ['five_hour', 'seven_day']
/** Two readings of one window may name its end a little differently. */
const SAME_WINDOW_MS = 10 * 60_000

/**
 * The account's usage limits as they stand now. Every session reports what it heard on its
 * last answer, so readings differ in age: a reading from a window that has already reset is
 * dropped, and within the current window the highest reading wins, since use only grows there.
 */
export function currentLimits(sessions, now) {
  const byKind = new Map()
  for (const session of sessions) {
    for (const limit of session.stats?.limits ?? []) {
      if (!limit || typeof limit.kind !== 'string' || !Number.isFinite(limit.percentUsed)) continue
      const resets = Date.parse(limit.resetsAt ?? '')
      if (Number.isFinite(resets) && resets <= now) continue
      byKind.set(limit.kind, [...(byKind.get(limit.kind) ?? []), { ...limit, resets }])
    }
  }
  return [...byKind]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([, readings]) => highestInLatestWindow(readings))
}

function highestInLatestWindow(readings) {
  const ends = readings.map(r => r.resets).filter(Number.isFinite)
  const latest = ends.length > 0 ? Math.max(...ends) : undefined
  const current = latest === undefined ? readings : readings.filter(r => !Number.isFinite(r.resets) || latest - r.resets < SAME_WINDOW_MS)
  const best = current.reduce((top, r) => (r.percentUsed > top.percentUsed ? r : top))
  const { resets, ...limit } = best
  return Number.isFinite(latest) ? { ...limit, resetsAt: new Date(latest).toISOString() } : limit
}

function rank(kind) {
  const at = LIMIT_ORDER.indexOf(kind)
  return at === -1 ? LIMIT_ORDER.length : at
}

/**
 * The board never shows less than it already showed for the same window: a reading that
 * drops back (a session with an older answer) is held at the peak until the window resets.
 */
export function holdPeaks(limits, peaks, now) {
  const next = new Map()
  const shown = limits.map(limit => {
    const peak = peaks.get(limit.kind)
    const resets = Date.parse(limit.resetsAt ?? '')
    const sameWindow = peak && (peak.resets === resets || (Number.isFinite(resets) && Math.abs(peak.resets - resets) < SAME_WINDOW_MS))
    const isLive = peak && !(Number.isFinite(peak.resets) && peak.resets <= now)
    const held = sameWindow && isLive && peak.percentUsed > limit.percentUsed ? { ...limit, percentUsed: peak.percentUsed } : limit
    next.set(limit.kind, { resets, percentUsed: held.percentUsed })
    return held
  })
  return { limits: shown, peaks: next }
}
