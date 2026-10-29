// The chat window's rules, kept apart from its drawing so they can be tested: how steps are
// folded, what of the reply being written is new, when the person can write, and which images go.

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_IMAGES = 6
// any other file dropped on the chat goes along too, as in the Claude app (serve.py MAX_FILES, MAX_FILE_BYTES)
export const MAX_FILES = 10
export const MAX_FILE_BYTES = 20 * 1024 * 1024
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
  if (session.endedAt !== undefined && isResumable) {
    return { canSend: true, note: 'This session ran in the background and stopped. Sending resumes it there, and your message goes in.', resumeHere: true }
  }
  if (session.endedAt !== undefined) {
    const where = isWakeable(session)
    const note = where
      ? `The session is asleep. Sending opens it in ${where}, which wakes it, and your message goes in.`
      : 'The session has ended. Your message goes in when it runs again.'
    return { canSend: true, note, wakeIn: where || undefined }
  }
  if (session.turn?.isRunning) return { canSend: true, note: 'Claude is working. Enter or Send queues it until Claude is done; ⌘Enter stops Claude and sends it now.' }
  return { canSend: true, note: '' }
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

/** Why an image cannot go with the message, or '' when it can. */
export function imageProblem(file, count) {
  if (count >= MAX_IMAGES) return `At most ${MAX_IMAGES} images in one message.`
  if (!IMAGE_TYPES.includes(file?.type)) return 'Only PNG, JPEG, GIF and WebP images can go along.'
  if (!(file.size > 0) || file.size > MAX_IMAGE_BYTES) return 'An image can be at most 10 MB.'
  return ''
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

/** The session's model, effort and mode, as its header shows them and its settings mark them. */
export function sessionSetup(session) {
  const stats = session?.stats ?? {}
  const modelId = typeof stats.model === 'string' ? stats.model : ''
  return {
    modelId,
    effort: typeof stats.effort === 'string' ? stats.effort : '',
    // the mode as the session's hooks saw it, else as its transcript last wrote it down
    mode: typeof stats.mode === 'string' && stats.mode ? stats.mode : typeof session?.permissionMode === 'string' ? session.permissionMode : '',
  }
}

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

/** Why a file that is not an image cannot go with the message, or '' when it can. */
export function fileProblem(file, count) {
  if (count >= MAX_FILES) return `At most ${MAX_FILES} files in one message.`
  if (!(file?.size > 0)) return 'That file is empty, or it is a folder.'
  if (file.size > MAX_FILE_BYTES) return 'A file can be at most 20 MB.'
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
export function approvalStatus(draft) {
  if (draft?.problem) return draft.problem
  if (draft?.state === 'sending') return 'Sending…'
  if (draft?.state === 'sent' && (draft.branch || draft.said)) return 'Sent. Claude goes on in a moment.'
  if (draft?.state === 'sent') return draft.choice === 'allow' ? 'Allowed. Claude goes on in a moment.' : 'Denied. Claude hears it in a moment.'
  return 'Answer here, or in the app.'
}

/** Where a question box can be answered from CCC: sessions in the Claude app and in VS Code. */
export const ANSWERS_FROM_CCC = new Set(['claude-desktop', 'claude-vscode'])

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
