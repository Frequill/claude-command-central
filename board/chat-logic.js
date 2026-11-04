// The chat window's rules, kept apart from its drawing so they can be tested: how steps are
// folded, what of the reply being written is new, when the person can write, and which images go.

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
// any other file dropped on the chat goes along too, as in the Claude app. CCC sets no limit of its
// own on how big they are or how many: each is sent to the server as it is (serve.py Inbox.receive).
/** The longest message the board's server takes (serve.py MESSAGE_TEXT_MAX): about what Claude can take in, 1 million tokens. */
export const MESSAGE_MAX = 4_000_000

// the app's own bookkeeping, which it shows as the steps card and the next-step box, never as steps
const HIDDEN_TOOLS = ['mcp__ccd_turn__update_plan', 'mcp__ccd_turn__wrap_up']

/** The chat's items with each run of steps Claude took folded into one `steps` item. */
/** The chat's items as drawn: Claude's notes between steps left out when the person hides them. */
export function shownItems(items, showNotes) {
  return showNotes === false ? items.filter(item => !item.note) : items
}

export function groupSteps(items) {
  const out = []
  for (const item of items ?? []) {
    if (item.kind === 'tool' && HIDDEN_TOOLS.includes(item.tool)) continue
    const last = out[out.length - 1]
    // a picture a step brought back (a screenshot) goes with its steps, as the app's small thumbnail
    // at the end of their line, and the run of steps goes on past it
    if (item.kind === 'image' && last?.kind === 'steps') last.pictures = [...(last.pictures ?? []), ...(item.pictures ?? [])]
    else if (item.kind === 'tool' && last?.kind === 'steps') last.steps.push(item)
    else if (item.kind === 'tool') out.push({ kind: 'steps', steps: [item] })
    else out.push(item)
  }
  return out
}

// how the app words a step, by its tool: once, and several times
const STEP_WORDS = {
  Bash: ['ran a command', 'ran {n} commands'],
  Read: ['read a file', 'read {n} files'],
  Edit: ['edited a file', 'edited {n} files'],
  MultiEdit: ['edited a file', 'edited {n} files'],
  Write: ['wrote a file', 'wrote {n} files'],
  NotebookEdit: ['edited a notebook', 'edited {n} notebooks'],
  Grep: ['searched the code', 'searched the code {n} times'],
  Glob: ['looked for files', 'looked for files {n} times'],
  WebSearch: ['searched the web', 'searched the web {n} times'],
  WebFetch: ['fetched a page', 'fetched {n} pages'],
  Agent: ['ran an agent', 'ran {n} agents'],
  Task: ['ran an agent', 'ran {n} agents'],
  Skill: ['used a skill', 'used {n} skills'],
  ToolSearch: ['loaded tools', 'loaded tools {n} times'],
  AskUserQuestion: ['asked you', 'asked you {n} times'],
}
// and a browser's actions, by the action's own name
const BROWSER_WORDS = {
  javascript_tool: ['ran page script', 'ran page script {n} times'],
  'computer:screenshot': ['captured page', 'captured page {n} times'],
  'computer:zoom': ['captured page', 'captured page {n} times'],
  'computer:wait': ['waited', 'waited {n} times'],
  navigate: ['opened a page', 'opened {n} pages'],
  read_page: ['read page', 'read page {n} times'],
  get_page_text: ['read page', 'read page {n} times'],
  find: ['searched page', 'searched page {n} times'],
  form_input: ['filled a form', 'filled {n} form fields'],
  read_console_messages: ['read console', 'read console {n} times'],
  read_network_requests: ['read network', 'read network {n} times'],
  resize_window: ['resized window', 'resized window {n} times'],
  preview_start: ['started preview', 'started preview {n} times'],
  preview_stop: ['stopped preview', 'stopped preview {n} times'],
}

/** The words for one action of a browser tool: clicks and keys are worked with the page. */
function browserWords(action) {
  if (BROWSER_WORDS[action]) return BROWSER_WORDS[action]
  const [name] = action.split(':')
  if (name === 'computer') return ['worked the page', 'worked the page {n} times']
  return BROWSER_WORDS[name] ?? ['used the browser', 'used the browser {n} times']
}

/** The phrases a step adds to its group's summary: one for most, one per action in a browser batch. */
function stepPhrases(step) {
  const tool = String(step?.tool ?? '')
  const browser = /^mcp__(Claude_Browser|claude-in-chrome)__(.+)$/.exec(tool)
  if (browser) {
    if (browser[2] === 'browser_batch') return (step.actions ?? []).map(browserWords)
    if (browser[2] === 'computer') return [['worked the page', 'worked the page {n} times']]
    return [browserWords(browser[2])]
  }
  if (STEP_WORDS[tool]) return [STEP_WORDS[tool]]
  const mcp = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(tool)
  const name = (mcp ? mcp[1] : tool).replace(/[_-]+/g, ' ').trim()
  return name ? [[`used ${name}`, `used ${name} {n} times`]] : [['took a step', 'took {n} steps']]
}

const FILE_VERBS = { Read: 'read', Edit: 'edited', MultiEdit: 'edited', Write: 'wrote', NotebookEdit: 'edited' }

/**
 * When every file step in a run touched the same file, the app names it: "read and edited
 * integrations.plist". Else undefined, and the steps are counted ("read 2 files").
 */
function oneFilePhrase(steps) {
  const fileSteps = steps.filter(step => FILE_VERBS[step?.tool])
  const names = new Set(fileSteps.map(step => step.file))
  if (fileSteps.length === 0 || names.size !== 1 || !fileSteps[0].file) return undefined
  const verbs = [...new Set(fileSteps.map(step => FILE_VERBS[step.tool]))]
  return `${verbs.join(' and ')} ${fileSteps[0].file}`
}

/** A run of steps summed up as the app does it: "Read and edited integrations.plist, ran a command". */
export function stepsSummary(steps) {
  const counts = new Map()
  const list = steps ?? []
  const filePhrase = oneFilePhrase(list)
  let isFileSaid = false
  for (const step of list) {
    if (filePhrase && FILE_VERBS[step?.tool]) {
      if (!isFileSaid) counts.set(filePhrase, { many: filePhrase, n: 1 })
      isFileSaid = true
      continue
    }
    for (const [one, many] of stepPhrases(step)) {
      const now = counts.get(one) ?? { many, n: 0 }
      now.n += 1
      counts.set(one, now)
    }
  }
  const phrases = [...counts].map(([one, { many, n }]) => (n === 1 ? one : many.replace('{n}', String(n))))
  const text = phrases.join(', ')
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : ''
}

/** The lines a run of steps added and took away from files, as the app's "+1 -0"; null with no change. */
export function linesChanged(steps) {
  const changes = (steps ?? []).filter(step => Number.isInteger(step?.added) && Number.isInteger(step?.removed))
  if (changes.length === 0) return null
  return { added: changes.reduce((sum, step) => sum + step.added, 0), removed: changes.reduce((sum, step) => sum + step.removed, 0) }
}

/**
 * What of the reply being written is not in the history yet. The history keeps Claude's text once
 * each block of it is done, while the reply streams; what follows the last kept block is new.
 */
export function liveRemainder(items, replyText) {
  const list = items ?? []
  let lastPrompt = -1
  list.forEach((item, i) => {
    if (item.kind === 'you') lastPrompt = i
  })
  let rest = String(replyText ?? '')
  for (const item of list.slice(lastPrompt + 1)) {
    if (item.kind !== 'claude') continue
    const text = item.text.trim()
    const at = text ? rest.indexOf(text) : -1
    if (at >= 0) rest = rest.slice(at + text.length)
  }
  return rest.trim()
}

/**
 * Whether the window can write to the session, and what to tell the person about it. `isResumable`:
 * it ran in the background and stopped, so sending picks it up there again.
 */
export function composeState(session, isResumable = false) {
  if (!session) return { canSend: false, note: 'This session is no longer on the board.' }
  if (!session.takesMessages) return { canSend: false, note: 'This session runs an older CCC. Restart it to write to it from here.' }
  // made on the board: its first message, with any images and files, starts Claude in the background
  if (session.planned && !session.begun) return { canSend: true, note: 'Write your first message. Sending it starts Claude here, in the background.', resumeHere: true }
  if (session.planned) return { canSend: true, note: 'Claude is starting in the background. A message you send now goes in once it runs.' }
  if (session.endedAt !== undefined && isResumable) {
    return { canSend: true, note: 'This session ran in the background and stopped. Sending resumes it there, and your message goes in.', resumeHere: true }
  }
  if (session.endedAt !== undefined) {
    const where = isWakeable(session)
    if (where) return { canSend: true, note: `The session is asleep. Sending opens it in ${where}, which wakes it, and your message goes in.`, wakeIn: where }
    // ended in its terminal: CCC picks it up in its own background, with the message
    return { canSend: true, note: 'The session ended in its terminal. Sending resumes it here, in CCC\u2019s background, and your message goes in.', resumeHere: true }
  }
  if (session.turn?.isRunning) return { canSend: true, note: 'Claude is working. Enter or Send queues it until Claude is done; ⌘Enter stops Claude and sends it now.' }
  return { canSend: true, note: '' }
}

/**
 * How a card's session comes back once Claude no longer runs it: null while it runs (or has not
 * started yet). What can bring it back depends on where it was started:
 * - 'app' / 'vscode': it is asleep there, and only that app can wake it (`actions` ['wake']);
 * - 'background': CCC ran it in its background, and it resumes there (['resume']);
 * - 'terminal': it ended in its terminal. CCC can resume it in its own background, or open it in a
 *   terminal app again (['resume', 'terminal']).
 * `state` is the card's (sessionState): 'stale' is a session that has not answered for a while, whose
 * terminal may have closed without a word. `isResumable`: it ran in CCC's background and stopped.
 * `label` is the word on the card's state pill, `text` the line on its bar.
 */
export function comeBack(session, state, isResumable = false) {
  if (!session || session.planned || (state !== 'ended' && state !== 'stale')) return null
  const isEnded = state === 'ended'
  const where = isWakeable(session)
  if (where) {
    return {
      kind: session.entrypoint === 'claude-vscode' ? 'vscode' : 'app',
      label: isEnded ? 'ASLEEP' : 'STALE',
      text: isEnded
        ? `Asleep in ${where}. Only ${where} can wake it: open it there, or write here and it opens.`
        : `It has not answered for a while. If ${where} closed it, open it there to wake it.`,
      actions: ['wake'],
    }
  }
  if (isResumable) {
    return { kind: 'background', label: 'STOPPED', text: 'It ran in CCC\u2019s background and stopped. Resume it there, or write here and it resumes with your message.', actions: ['resume'] }
  }
  return {
    kind: 'terminal',
    label: isEnded ? 'ENDED' : 'STALE',
    text: isEnded
      ? 'It ended in its terminal. Resume it here, in CCC\u2019s background, or in a terminal again.'
      : 'It has not answered for a while: its terminal may have closed. If so, resume it here or in a terminal.',
    actions: ['resume', 'terminal'],
  }
}

/**
 * Where a session that has stopped can be woken: the Claude app or VS Code start it again when the
 * chat is opened there. A terminal session cannot be woken from here.
 */
export function isWakeable(session) {
  if (/^local_[A-Za-z0-9-]{1,64}$/.test(session?.appSessionId ?? '')) return 'the Claude app'
  if (session?.entrypoint === 'claude-vscode') return 'VS Code'
  return ''
}

// a prompt longer than this, in lines or characters, is shown cut down with Show more, as in the app
const PROMPT_LINES = 6
const PROMPT_CHARS = 480

/** Whether a prompt is long enough to be cut down to its first lines. */
export function isLongPrompt(text) {
  const words = String(text ?? '')
  return words.length > PROMPT_CHARS || words.split('\n').length > PROMPT_LINES
}

/** What a prompt is known by while the chat redraws: its length and its first words. */
export function promptKey(text) {
  const words = String(text ?? '')
  return `${words.length}:${words.slice(0, 120)}`
}

/** Why a message is too long to send, or '' when it is not. */
export function lengthProblem(text) {
  const length = String(text ?? '').length
  if (length <= MESSAGE_MAX) return ''
  const spaced = number => number.toLocaleString('en-US').replace(/,/g, ' ')
  return `The message is too long: ${spaced(length)} characters, at most ${spaced(MESSAGE_MAX)}.`
}

/** A file's size the way the app writes it: 820 B, 14 KB, 3.2 MB. */
export function fileSize(bytes) {
  if (!(bytes >= 0)) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// the effort levels /effort takes, low to high
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// the models offered when the session has not said which it takes (an older CCC)
const DEFAULT_MODELS = ['default', 'sonnet', 'opus', 'haiku', 'fable', 'best', 'opusplan']

/**
 * The session's model, effort and mode, as its header shows them and its settings mark them. A
 * session in CCC's background has its mode read off its own screen (`terminal.mode`): changed in
 * CCC or in its terminal, that is the mode it has now.
 */
export function sessionSetup(session, terminal = null) {
  const stats = session?.stats ?? {}
  // a model or effort picked in CCC's menu for this session alone counts from its very next request
  const choice = session?.choice ?? {}
  const picked = typeof choice.model === 'string' && choice.model ? choice.model : null
  const modelId = picked ?? (typeof stats.model === 'string' ? stats.model : '')
  const written = typeof stats.mode === 'string' && stats.mode ? stats.mode : typeof session?.permissionMode === 'string' ? session.permissionMode : ''
  return {
    modelId,
    picked,
    effort: typeof choice.effort === 'string' && choice.effort ? choice.effort : typeof stats.effort === 'string' ? stats.effort : '',
    // else the mode as the session's hooks saw it, else as its transcript last wrote it down
    mode: typeof terminal?.mode === 'string' && terminal.mode ? terminal.mode : written === 'default' ? 'manual' : written,
  }
}

/**
 * A design's canvas as the Design tab lays it out: its screens and row titles moved so the canvas
 * starts at 0, with room above each row for the screens' titles. In the canvas's own units.
 */
export function designLayout(design, labelRoom = 60) {
  const screens = Array.isArray(design?.screens) ? design.screens : []
  const notes = Array.isArray(design?.notes) ? design.notes : []
  if (screens.length === 0) return { w: 1, h: 1, screens: [], notes: [] }
  const xs = [...screens.map(one => one.x), ...notes.map(one => one.x)]
  const ys = [...screens.map(one => one.y), ...notes.map(one => one.y)]
  const left = Math.min(...xs)
  const top = Math.min(...ys) - labelRoom
  const right = Math.max(...screens.map(one => one.x + one.w))
  const bottom = Math.max(...screens.map(one => one.y + one.h))
  return {
    w: right - left,
    h: bottom - top,
    screens: screens.map(one => ({ ...one, x: one.x - left, y: one.y - top })),
    notes: notes.map(one => ({ ...one, x: one.x - left, y: one.y - top })),
  }
}

/** How much smaller the canvas is drawn to fit the room the card gives it; never larger than itself. */
export function designScale(layout, room, margin = 16) {
  return Math.max(0.01, Math.min(1, (room.w - margin) / layout.w, (room.h - margin) / layout.h))
}

/** The modes a session in CCC's background can be switched to, named as Claude's own mode line names them. */
export const MODE_CHOICES = [
  { id: 'manual', label: 'manual' },
  { id: 'acceptEdits', label: 'accept edits' },
  { id: 'plan', label: 'plan' },
  { id: 'auto', label: 'auto' },
]

// caveman mode as the board's server keeps it: off, or how terse Claude answers
export const CAVEMAN_LEVELS = ['off', 'lite', 'full', 'ultra']

/** The caveman level in force for a session: its own choice, else the default for every session. */
export function cavemanOf(choices, sessionId) {
  const known = level => (CAVEMAN_LEVELS.includes(level) ? level : undefined)
  const own = known(choices?.sessions?.[sessionId])
  return { level: own ?? known(choices?.default) ?? 'off', isOwn: own !== undefined }
}

/** What the title bar's rock button switches to: off when on, else the level last used (full at first). */
export function cavemanToggled(level, lastOn) {
  if (level !== 'off') return 'off'
  return CAVEMAN_LEVELS.includes(lastOn) && lastOn !== 'off' ? lastOn : 'full'
}

// the model families Claude Code's aliases name
const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable']
// a full model id: claude-opus-5-5, claude-sonnet-4-5-20250929, claude-opus-5-5[1m]
const MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i
// what the aliases that are no family stand for, as Claude's own model picker words them
const MODEL_ALIASES = {
  default: { name: 'Default', about: 'What your account uses unless you pick one' },
  best: { name: 'Best', about: 'The most capable model there is' },
  opusplan: { name: 'Opus Plan', about: 'Opus while planning, then Sonnet' },
}

function parsedModel(id) {
  const match = MODEL_ID.exec(String(id ?? '').trim())
  if (!match) return null
  const [, family, major, minor, long] = match
  return { family: family.toLowerCase(), version: [Number(major), Number(minor ?? 0)], text: minor ? `${major}.${minor}` : major, isLong: Boolean(long) }
}

/**
 * The version each model family runs now, from the models the board's sessions ran: the newest
 * seen of each ({ opus: '5.5', sonnet: '5.5' }). Read from the sessions, so it follows each new model.
 */
export function modelVersions(sessions) {
  const newest = {}
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const model = parsedModel(session?.stats?.model)
    if (!model || !MODEL_FAMILIES.includes(model.family)) continue
    const known = newest[model.family]
    if (!known || model.version[0] > known.version[0] || (model.version[0] === known.version[0] && model.version[1] > known.version[1])) newest[model.family] = model
  }
  return Object.fromEntries(Object.entries(newest).map(([family, model]) => [family, model.text]))
}

/** A model's name as Claude's picker shows it: "Opus 5.5", "Default", "Sonnet 5.5 · 1M"; an alias, a full id or anything else. */
export function modelLabel(option, versions = {}) {
  const raw = String(option ?? '').trim()
  const isLong = /\[1m\]$/i.test(raw)
  const bare = raw.replace(/\[1m\]$/i, '').toLowerCase()
  const long = isLong ? ' · 1M' : ''
  if (MODEL_ALIASES[bare]) return MODEL_ALIASES[bare].name + long
  if (MODEL_FAMILIES.includes(bare)) return `${bare[0].toUpperCase()}${bare.slice(1)}${versions[bare] ? ` ${versions[bare]}` : ''}${long}`
  const model = parsedModel(raw)
  return model ? `${model.family[0].toUpperCase()}${model.family.slice(1)} ${model.text}${model.isLong ? ' · 1M' : ''}` : raw
}

/** The line under a model in the picker, for the aliases whose meaning is not their name; '' for the rest. */
export function modelAbout(option) {
  return MODEL_ALIASES[String(option ?? '').trim().toLowerCase()]?.about ?? ''
}

/**
 * The session menu's model row, as Claude's picker has it: each model once, and "1M context" as a
 * switch of its own for the families that have a 1M version. `picked` is the model picked for this
 * session in CCC, or null when none is: then Default is on, the session's own model.
 * Each choice is { option (what the session is sent with), label, about, isOn }; `long` is the switch, or null.
 */
export function modelMenu(options, picked, versions = {}) {
  const list = modelChoices(options)
  const current = picked ?? 'default'
  const isLongNow = /\[1m\]$/i.test(String(current ?? ''))
  const longOf = option => list.find(one => one.toLowerCase() === `${option.toLowerCase()}[1m]`)
  const choices = list
    .filter(option => !/\[1m\]$/i.test(option))
    .map(option => ({
      option,
      label: modelLabel(option, versions),
      about: modelAbout(option),
      isOn: sameChoice(option, current) || (isLongNow && Boolean(longOf(option)) && sameChoice(longOf(option), current)),
      long: longOf(option) ?? null,
    }))
  const lit = choices.find(choice => choice.isOn)
  const hasLong = choices.some(choice => choice.long)
  return { choices, long: hasLong ? { isOn: isLongNow, canSwitch: Boolean(lit?.long), option: lit ? (isLongNow ? lit.option : lit.long) : null } : null }
}

/** What a setting note in the chat says: "Model set to Opus 5.5", "Effort set to high". */
export function settingNote(item, versions = {}) {
  if (item?.setting === 'model') return `Model set to ${modelLabel(item.value, versions)}`
  if (item?.setting === 'effort') return `Effort set to ${item.value}`
  return String(item?.text ?? '')
}

/** A queued /model or /effort, as the chat says it waits: { setting, value }, or null for any other message. */
export function settingCommand(text) {
  const match = /^\/(model|effort)\s+([A-Za-z0-9._[\]-]{1,80})$/.exec(String(text ?? '').trim())
  return match ? { setting: match[1], value: match[2] } : null
}

/** The models to offer: the session's own list, else the usual aliases. */
export function modelChoices(models) {
  const list = Array.isArray(models) ? models.filter(model => typeof model === 'string' && model) : []
  return list.length ? list : DEFAULT_MODELS
}

/** Whether a choice is what the session runs now: an alias (opus) matches its full id (claude-opus-5-5). */
export function sameChoice(option, current) {
  const want = String(current ?? '').toLowerCase()
  const pick = String(option ?? '').toLowerCase()
  if (!want || !pick) return false
  if (want === pick) return true
  const isLong = pick.includes('[1m]') === want.includes('[1m]')
  const family = pick.replace('[1m]', '')
  return isLong && ['opus', 'sonnet', 'haiku', 'fable'].includes(family) && want.startsWith(`claude-${family}-`)
}

// how many sessions' closed steps cards are remembered; the oldest are forgotten first
const CLOSED_PLANS_KEPT = 200

/** What a steps card is known by when it is closed: every step's words and state, so any change shows it again. */
export function planKey(plan) {
  return (Array.isArray(plan) ? plan : []).map(step => `${step?.status ?? ''}:${step?.text ?? ''}`).join('\n')
}

/** Whether the person closed this session's steps card as it is now. */
export function isPlanClosed(closed, sessionId, plan) {
  return Boolean(closed?.[sessionId]) && closed[sessionId] === planKey(plan)
}

/** The closed cards with this one added, the oldest dropped past the limit. */
export function closePlan(closed, sessionId, plan) {
  const next = { ...(closed ?? {}) }
  delete next[sessionId]
  next[sessionId] = planKey(plan)
  const ids = Object.keys(next)
  for (const id of ids.slice(0, Math.max(0, ids.length - CLOSED_PLANS_KEPT))) delete next[id]
  return next
}

const DRAFTS_KEPT = 100
const DRAFT_DAYS = 30
// a draft bigger than this (a whole pasted log) is not kept: the browser's storage would not hold it
export const DRAFT_MAX = 500_000

/**
 * The words written in each chat and not sent yet, by session, newest last. Empty words drop the
 * draft; only the newest hundred are kept.
 */
export function keepDraft(drafts, sessionId, text, now) {
  const next = { ...(drafts ?? {}) }
  delete next[sessionId]
  if (typeof text === 'string' && text.trim() !== '' && text.length <= DRAFT_MAX) next[sessionId] = { text, at: now }
  const ids = Object.keys(next)
  for (const id of ids.slice(0, Math.max(0, ids.length - DRAFTS_KEPT))) delete next[id]
  return next
}

/** The words a chat had not sent yet, or '' when there are none or they are a month old. */
export function draftOf(drafts, sessionId, now) {
  const draft = drafts?.[sessionId]
  if (!draft || typeof draft.text !== 'string' || !Number.isFinite(draft.at)) return ''
  return now - draft.at > DRAFT_DAYS * 86_400_000 ? '' : draft.text
}

/** The app's suggested next prompt for the session, while Claude is not working; else ''. */
export function suggestionOf(session) {
  const turn = session?.turn
  if (!turn || turn.isRunning || typeof turn.suggestion !== 'string') return ''
  return turn.suggestion.trim()
}

/** What follows the "/" while the first word of the box is a slash command being typed, else null. */
export function slashTyped(text) {
  const match = /^\/([^\s]*)$/.exec(String(text ?? ''))
  return match ? match[1] : null
}

/** The commands that match what is typed after the "/": names that start with it first, then names that hold it. */
export function matchCommands(commands, typed) {
  const want = String(typed ?? '').toLowerCase()
  const list = Array.isArray(commands) ? commands.filter(command => typeof command?.name === 'string') : []
  const starts = list.filter(command => command.name.toLowerCase().startsWith(want))
  const holds = list.filter(command => !command.name.toLowerCase().startsWith(want) && command.name.toLowerCase().includes(want))
  return [...starts, ...holds]
}

/**
 * The "@" being typed where the cursor is, as the Claude app's prompt box takes one: at the start of
 * the box or after a space, up to the cursor. Where it starts and what follows it, else null.
 */
export function mentionTyped(text, caret) {
  const before = String(text ?? '').slice(0, caret)
  const match = /(^|\s)@([^\s@"]*)$/.exec(before)
  return match ? { start: before.length - match[2].length - 1, typed: match[2] } : null
}

/**
 * The box with a picked path in place of the "@" being typed: a file with a space after it, a folder
 * with none, so its own files can be picked next. A path with a space in it goes in quotes, as Claude
 * Code reads it. The new text and where the cursor goes.
 */
export function withMention(text, mention, caret, path) {
  const value = String(text ?? '')
  const isFolder = path.endsWith('/')
  const put = /\s/.test(path) ? `@"${path}"` : `@${path}`
  const added = isFolder && !put.endsWith('"') ? put : `${put} `
  return { value: value.slice(0, mention.start) + added + value.slice(caret), caret: mention.start + added.length }
}

/** The tag beside a command in the menu: a skill or command of a plugin, the user's own, or built in. */
export function commandKind(command) {
  return { builtin: 'built-in', plugin: 'plugin', user: 'yours', mcp: 'MCP' }[command?.source] ?? ''
}

/** Whether a dropped file goes as an image Claude sees, or as a file it opens. */
export function isImage(file) {
  return IMAGE_TYPES.includes(file?.type)
}

/** Why a file or image cannot go with the message, or '' when it can: only nothing to send. */
export function fileProblem(file) {
  if (!(file?.size > 0)) return 'That file is empty, or it is a folder.'
  return ''
}

/**
 * The options an answer picked: the one whose label it is, or for a box where more than one can be
 * picked, each label it lists. An answer the person wrote in their own words picks none.
 */
export function chosenOptions(question, answer) {
  const text = String(answer ?? '').trim()
  const labels = (question?.options ?? []).map(option => option.label)
  if (!text) return new Set()
  if (labels.includes(text)) return new Set([text])
  if (!question?.multiSelect) return new Set()
  const parts = text.split(',').map(part => part.trim())
  return parts.every(part => labels.includes(part)) ? new Set(parts) : new Set()
}

// the words the app's box uses for the tools that touch a file or an address
const APPROVAL_VERBS = { Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write', Read: 'read', WebFetch: 'fetch' }

/**
 * What an approval box says, as the app's box does: the question, why it asks, and the command,
 * file or input it is about. It can be answered from CCC only while the session's hook holds the
 * box open (the Claude app and VS Code); else it says where to answer.
 */
export function approvalView(waiting) {
  if (waiting?.kind !== 'approval') return null
  const box = waiting.box && typeof waiting.box === 'object' ? waiting.box : null
  const tool = typeof box?.tool === 'string' ? box.tool : ''
  // the Claude app's branch question comes as an approval box; it is drawn as the app draws it
  const branch = box?.kind === 'branch' ? { suggested: typeof box.suggested === 'string' ? box.suggested : '' } : null
  // seen only on the screen of a Claude in CCC's background: what it asks is there
  if (waiting.onScreen) return { branch: null, title: 'Claude asks you something in its terminal', description: '', reason: '', code: '', box: '', canAnswer: false }
  return {
    branch,
    title: branch ? 'Work on a separate branch?' : approvalTitle(box, tool),
    // a command's description is in the question already
    description: box && box.command === undefined && box.description ? box.description : '',
    reason: typeof waiting.reason === 'string' ? waiting.reason : '',
    code: box?.command ?? box?.target ?? box?.detail ?? waiting.text ?? '',
    box: typeof box?.box === 'string' ? box.box : '',
    canAnswer: typeof box?.box === 'string' && box.box !== '',
  }
}

function approvalTitle(box, tool) {
  if (!box) return 'Claude asks to go ahead with this'
  if (box.command !== undefined) return `Allow Claude to run ${box.description || 'this command'}?`
  if (APPROVAL_VERBS[tool] && box.target) return `Allow Claude to ${APPROVAL_VERBS[tool]} ${String(box.target).split('/').filter(Boolean).pop() ?? box.target}?`
  return `Allow Claude to use ${toolLabel(tool)}?`
}

/** A tool as a person reads it: a connector's tool with the connector it comes from. */
export function toolLabel(tool) {
  const parts = String(tool ?? '').split('__')
  if (parts[0] === 'mcp' && parts.length >= 3) return `${parts.slice(2).join('__')} (${parts[1]})`
  return String(tool ?? '') || 'a tool'
}

/** What the approval box says once the person answered it here, or while that goes out. */
export function approvalStatus(draft, place = 'the app') {
  if (draft?.problem) return draft.problem
  if (draft?.state === 'sending') return 'Sending…'
  if (draft?.state === 'sent' && (draft.branch || draft.said)) return 'Sent. Claude goes on in a moment.'
  if (draft?.state === 'sent') return draft.choice === 'allow' ? 'Allowed. Claude goes on in a moment.' : 'Denied. Claude hears it in a moment.'
  return `Answer here, or in ${place}.`
}

/** Where a question box in the transcript can be answered from CCC with no word from its hook: the app and VS Code. */
export const ANSWERS_FROM_CCC = new Set(['claude-desktop', 'claude-vscode'])

/**
 * Whether a question box can be answered from CCC: CCC's question hook waits with it (wherever the
 * session runs, the app, VS Code or a terminal), or the session runs in the app or VS Code.
 */
export function canAnswerQuestion(item, session) {
  return Boolean(item?.toolId) && (item.isWaiting === true || ANSWERS_FROM_CCC.has(session?.entrypoint))
}

/** A question box that only its hook knows of so far: a terminal writes its box down once it is answered. */
export function isHookBox(item) {
  return item?.kind === 'question' && typeof item.toolId === 'string' && item.toolId.startsWith('box-')
}

/** Where else a box can be answered, as the board's lines name it: the app, VS Code or its terminal. */
export function answerPlace(session) {
  if (session?.entrypoint === 'claude-desktop') return 'the app'
  if (session?.entrypoint === 'claude-vscode') return 'VS Code'
  return 'its terminal'
}

/** A fresh draft answer for a box: nothing picked, no words of the person's own. */
export function emptyDraft(questions) {
  return { state: 'editing', problem: '', sentAt: 0, parts: (questions ?? []).map(() => ({ picks: [], other: '', isOther: false })) }
}

/**
 * The draft once the person clicks an option: in a box with one answer it becomes the answer (and
 * words of their own are set aside); where more than one may be picked it goes in or out.
 */
export function pickOption(question, part, label) {
  if (question?.multiSelect) {
    const picks = part.picks.includes(label) ? part.picks.filter(one => one !== label) : [...part.picks, label]
    return { ...part, picks }
  }
  return { ...part, picks: [label], isOther: false }
}

/** The draft once the person turns to their own words: the only answer, or one more beside the picks. */
export function chooseOther(question, part) {
  if (question?.multiSelect) return { ...part, isOther: !part.isOther }
  return { ...part, picks: [], isOther: true }
}

/** What a draft answers to one question, as the app sends it: a label, labels with commas, or the person's words. */
export function answerText(question, part) {
  const own = part?.isOther ? String(part.other ?? '').trim() : ''
  if (question?.multiSelect) {
    const labels = (question.options ?? []).map(option => option.label).filter(label => part?.picks?.includes(label))
    return [...labels, own].filter(Boolean).join(', ')
  }
  return part?.isOther ? own : (part?.picks?.[0] ?? '')
}

/** Whether every question of the box has an answer in the draft. */
export function isDraftReady(questions, draft) {
  return (questions ?? []).length > 0 && questions.every((question, i) => answerText(question, draft?.parts?.[i]) !== '')
}

/**
 * What Enter does with a message: while Claude works it queues, so a stray Enter never stops Claude;
 * with Cmd (or Ctrl) held it stops Claude and sends now, as Send does.
 */
export function enterMode(isWorking, withCommand) {
  return isWorking && !withCommand ? 'queue' : 'now'
}

// ---------- Run ----------

// the code blocks a Run button goes on: shell commands, as the Claude app offers Run on them
const SHELL_LANGS = ['bash', 'sh', 'zsh', 'shell']

/** Whether a code block is a shell command the person can run from the chat. */
export function isRunnable(block) {
  return block?.type === 'code' && SHELL_LANGS.includes(String(block.lang ?? '').toLowerCase()) && String(block.text ?? '').trim() !== ''
}

/** The newest run of a command in a session's runs, or undefined when it never ran. */
export function runOf(runs, command) {
  return (runs ?? []).filter(run => run?.command === command).at(-1)
}

/**
 * How a run went, in a word for its pill: waiting (for the one before it in the session's terminal),
 * running, done (exit 0), failed (another exit) or closed (its terminal went first).
 */
export function runState(run) {
  if (!run?.endedAt) return run?.typedAt ? 'running' : 'waiting'
  if (!Number.isInteger(run.exitCode)) return 'closed'
  return run.exitCode === 0 ? 'done' : 'failed'
}

/** The words of a run's status line. */
export function runLabel(run) {
  const state = runState(run)
  if (state === 'waiting') return 'Waiting for the terminal…'
  if (state === 'running') return 'Running…'
  if (state === 'closed') return run.typedAt ? 'Closed before it ended' : 'Its terminal closed before it ran'
  return state === 'done' ? 'Done' : `Failed, exit ${run.exitCode}`
}

/**
 * Where Claude is with a run: it gets how it went once it ends (sent in a message of its own), or
 * hears of it with the next message when it did not end by itself.
 */
export function runHeard(run) {
  if (run?.told) return 'Claude has seen this'
  if (run?.sentAt) return 'Sent to Claude'
  const state = runState(run)
  return state === 'waiting' || state === 'running' ? 'Goes to Claude when it ends' : 'Claude sees this with your next message'
}

// ---------- emoji ----------

// the emoji the picker offers, each with its shortcode (:name:) and the words a search finds it by
export const EMOJI = [
  ['😀', 'grinning', 'happy smile grin'], ['😄', 'smile', 'happy laugh joy'], ['😁', 'grin', 'teeth happy'], ['😂', 'joy', 'laugh tears lol'],
  ['🤣', 'rofl', 'laugh rolling lol'], ['🙂', 'slight_smile', 'smile happy'], ['😉', 'wink', 'wink flirt'], ['😊', 'blush', 'happy shy'],
  ['😍', 'heart_eyes', 'love crush'], ['🥰', 'smiling_hearts', 'love adore'], ['😘', 'kiss', 'love'], ['😎', 'sunglasses', 'cool'],
  ['🤓', 'nerd', 'geek glasses'], ['🤔', 'thinking', 'hmm think wonder'], ['🤨', 'raised_eyebrow', 'doubt sceptic'], ['😐', 'neutral', 'meh blank'],
  ['🙄', 'eye_roll', 'annoyed whatever'], ['😏', 'smirk', 'smug'], ['😅', 'sweat_smile', 'phew nervous'], ['😬', 'grimace', 'awkward oops'],
  ['😮', 'open_mouth', 'wow surprised'], ['😲', 'astonished', 'shock wow'], ['🤯', 'mind_blown', 'explode wow'], ['😴', 'sleeping', 'tired zzz'],
  ['😢', 'cry', 'sad tear'], ['😭', 'sob', 'cry sad'], ['😤', 'triumph', 'huff proud'], ['😠', 'angry', 'mad'],
  ['😡', 'rage', 'angry mad furious'], ['🤬', 'cursing', 'swear angry'], ['😱', 'scream', 'fear shock'], ['🥳', 'party', 'celebrate birthday'],
  ['🤗', 'hug', 'hugs warm'], ['🤩', 'star_struck', 'wow amazing'], ['😇', 'innocent', 'angel halo'], ['🙃', 'upside_down', 'silly irony'],
  ['😜', 'stuck_out_tongue_wink', 'silly joke'], ['🤪', 'zany', 'crazy silly'], ['🫠', 'melting', 'hot embarrassed'], ['🫡', 'salute', 'respect yes sir'],
  ['👍', 'thumbsup', 'yes ok good like +1'], ['👎', 'thumbsdown', 'no bad dislike -1'], ['👌', 'ok_hand', 'ok perfect'], ['✌️', 'v', 'peace victory'],
  ['🤞', 'crossed_fingers', 'luck hope'], ['👏', 'clap', 'applause bravo'], ['🙌', 'raised_hands', 'yay celebrate'], ['🙏', 'pray', 'please thanks'],
  ['💪', 'muscle', 'strong flex'], ['👋', 'wave', 'hello hi bye'], ['🤝', 'handshake', 'deal agree'], ['👀', 'eyes', 'look see watch'],
  ['🧠', 'brain', 'think smart'], ['❤️', 'heart', 'love red'], ['🧡', 'orange_heart', 'love'], ['💛', 'yellow_heart', 'love'],
  ['💚', 'green_heart', 'love'], ['💙', 'blue_heart', 'love'], ['💜', 'purple_heart', 'love'], ['🖤', 'black_heart', 'love dark'],
  ['💔', 'broken_heart', 'sad'], ['✨', 'sparkles', 'shiny new magic'], ['🔥', 'fire', 'hot lit great'], ['⭐', 'star', 'favourite'],
  ['🌟', 'glowing_star', 'shine'], ['⚡', 'zap', 'fast lightning'], ['💥', 'boom', 'explosion crash'], ['💯', '100', 'perfect hundred'],
  ['✅', 'white_check_mark', 'done yes check'], ['✔️', 'check', 'done yes'], ['❌', 'x', 'no wrong cross'], ['⚠️', 'warning', 'careful alert'],
  ['❓', 'question', 'what why'], ['❗', 'exclamation', 'important'], ['🎉', 'tada', 'party celebrate hooray'], ['🎊', 'confetti', 'party'],
  ['🚀', 'rocket', 'ship launch fast'], ['🛠️', 'tools', 'fix build'], ['🔧', 'wrench', 'fix tool'], ['🐛', 'bug', 'error insect'],
  ['💡', 'bulb', 'idea light'], ['📌', 'pushpin', 'pin note'], ['📎', 'paperclip', 'attach'], ['📝', 'memo', 'note write'],
  ['📊', 'bar_chart', 'stats chart data'], ['📈', 'chart_up', 'growth trend'], ['📉', 'chart_down', 'drop trend'], ['🗂️', 'dividers', 'files folders'],
  ['💻', 'computer', 'laptop code'], ['🖥️', 'desktop', 'screen computer'], ['⌨️', 'keyboard', 'type'], ['🔒', 'lock', 'secure private'],
  ['🔑', 'key', 'password access'], ['📦', 'package', 'box ship deploy'], ['🧪', 'test_tube', 'test experiment'], ['🔍', 'mag', 'search find'],
  ['⏳', 'hourglass', 'wait time'], ['⏰', 'alarm', 'time clock'], ['☕', 'coffee', 'break drink'], ['🍕', 'pizza', 'food'],
  ['🍺', 'beer', 'drink cheers'], ['🎯', 'dart', 'target goal'], ['🏆', 'trophy', 'win award'], ['🎮', 'video_game', 'game play'],
  ['🤖', 'robot', 'bot ai claude'], ['👾', 'alien_monster', 'game space'], ['👻', 'ghost', 'boo'], ['💀', 'skull', 'dead lol'],
  ['🐱', 'cat', 'kitty'], ['🐶', 'dog', 'puppy'], ['🦄', 'unicorn', 'magic'], ['🌈', 'rainbow', 'colour'],
  ['☀️', 'sunny', 'sun weather'], ['🌙', 'moon', 'night'], ['🌊', 'wave_water', 'sea ocean'], ['🌸', 'blossom', 'flower spring'],
]

// emoticons typed as text, as the app's keyboard would turn them
const EMOTICONS = {
  ':)': '🙂', ':-)': '🙂', ':D': '😄', ':-D': '😄', ';)': '😉', ';-)': '😉', ':(': '😢', ':-(': '😢',
  ":'(": '😭', ':P': '😛', ':-P': '😛', ':p': '😛', ':O': '😮', ':o': '😮', ':|': '😐', ':/': '😕',
  'xD': '😆', 'XD': '😆', '<3': '❤️', '</3': '💔', 'B)': '😎', '^^': '😊', ':*': '😘', 'o/': '👋',
}

const SHORTCODES = new Map(EMOJI.map(([emoji, code]) => [code, emoji]))

/** The emoji a typed word stands for: an emoticon, or a :shortcode:; else undefined. */
export function emojiFor(word) {
  if (Object.hasOwn(EMOTICONS, word)) return EMOTICONS[word]
  const code = /^:([a-z0-9_+-]{1,40}):$/.exec(word)
  return code ? SHORTCODES.get(code[1]) : undefined
}

/**
 * The text with the word that ends at `caret` turned into its emoji, and where the caret goes; or
 * null when that word is no emoji. A word stands on its own between spaces, and a word inside
 * code (between backticks) is left alone.
 */
export function emojifyAt(text, caret) {
  const before = String(text ?? '').slice(0, caret)
  const word = /(?:^|\s)(\S+)$/.exec(before)?.[1]
  const emoji = word ? emojiFor(word) : undefined
  if (!emoji) return null
  const ticks = (before.match(/`/g) ?? []).length
  if (ticks % 2 === 1) return null
  const start = before.length - word.length
  return { text: `${text.slice(0, start)}${emoji}${text.slice(caret)}`, caret: start + emoji.length }
}

/** The emoji whose name or words hold what is searched for; all of them for an empty search. */
export function findEmoji(search) {
  const words = String(search ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return EMOJI.filter(([, code, about]) => words.every(word => code.includes(word) || about.includes(word)))
}

/**
 * Whether a queued message waits for the person's answer to Claude's question: it was queued while
 * the turn ran that ended with the question, whose buttons are still up. The mod holds it so (its
 * inbox's isHeld), and lets the answer go in first.
 */
export function isHeldForAnswer(session, message) {
  const turn = session?.turn
  const at = Number(message?.at)
  if (!turn || turn.isRunning || !(turn.choices?.length > 0) || message?.mode !== 'queue' || !Number.isFinite(at)) return false
  return at >= Number(turn.startedAt) && at <= Number(turn.endedAt)
}
