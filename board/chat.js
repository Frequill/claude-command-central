// An expanded card: a double-click on a card, or its middle corner button, opens the card where it
// is on the board into its session's chat, wide and tall, with the other cards moving aside. It is
// moved and resized like any card, and several can be open side by side. It reads the session's
// own history, shows what Claude writes right now, what the small card told (model, spend,
// terminal, task list, agents), and has a box to write back in, images included. The board keeps
// the same element across its redraws, so what is being typed stays. Text goes in as textContent.

import * as L from './board-logic.js'
import * as C from './chat-logic.js'
import { blocks } from './markdown.js'

const REFRESH_MS = 1500
const SVG_NS = 'http://www.w3.org/2000/svg'

let context = null
/** The expanded cards, one per session id. */
const chats = new Map()

/**
 * The board's view of a session: `sessionOf(id)`, `titleOf(id)`, `colorOf(id)`, its facts
 * (`statsOf(id)`: a signature and a node), `onRemove(id, title)` when the person closes it, and
 * whether its panel of facts is folded in (`isSideHidden(id)`, `onSide(id, isHidden)`).
 */
export function setupChat(given) {
  context = given
}

/** Draws every chat again, as a setting that changes what it shows was switched. */
export function redrawChats() {
  for (const chat of chats.values()) {
    chat.signature = ''
    refresh(chat)
  }
}

// ---------- small DOM helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (name === 'class') node.className = value
    else node.setAttribute(name, String(value))
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child)
  return node
}

function icon(d, size = 14) {
  const node = document.createElementNS(SVG_NS, 'svg')
  node.setAttribute('width', size)
  node.setAttribute('height', size)
  node.setAttribute('viewBox', '0 0 16 16')
  node.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  for (const [name, value] of Object.entries({ d, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(name, value)
  node.append(path)
  return node
}

// ---------- the expanded card ----------

/** The expanded card of a session, made once and kept: the board places it in its grid. */
export function chatCard(sessionId) {
  let chat = chats.get(sessionId)
  if (chat) return chat.root
  chat = buildCard(sessionId)
  chats.set(sessionId, chat)
  update(chat)
  refresh(chat)
  chat.timer = setInterval(() => refresh(chat), REFRESH_MS)
  return chat.root
}

/** Forgets an expanded card: its updates stop and what was being written goes. */
export function dropChat(sessionId) {
  const chat = chats.get(sessionId)
  if (!chat) return
  clearInterval(chat.timer)
  for (const image of chat.images) URL.revokeObjectURL(image.url)
  chats.delete(sessionId)
}

/** Puts the cursor in an expanded card's write box, leaving the page where it is. */
export function focusChat(sessionId) {
  chats.get(sessionId)?.text.focus({ preventScroll: true })
}

/** Called on every board update: each expanded card's header, live part, box and facts follow it. */
export function updateChat() {
  for (const chat of chats.values()) update(chat)
}

function update(chat) {
  const session = context.sessionOf(chat.id)
  drawHead(chat, session)
  drawLive(chat, session)
  drawCompose(chat, session)
  drawStats(chat)
  keepScroll(chat)
}

/** Puts the chat back where it was after the card was moved: at its newest line, or where the person left it. */
function keepScroll(chat) {
  const { scroll } = chat
  if (chat.isFollowing !== false) {
    if (!L.isAtBottom(scroll)) scroll.scrollTop = scroll.scrollHeight
  } else if (scroll.scrollTop === 0 && chat.top > 0) {
    scroll.scrollTop = chat.top
  }
}

function markHand(chat) {
  chat.isScrolledByHand = true
  clearTimeout(chat.handTimer)
  chat.handTimer = setTimeout(() => {
    chat.isScrolledByHand = false
  }, 800)
}

function drawStats(chat) {
  const stats = context.statsOf(chat.id)
  if (!stats || stats.signature === chat.statsSignature) return
  chat.statsSignature = stats.signature
  chat.side.replaceChildren(stats.node)
}

function buildCard(sessionId) {
  const head = el('header', { class: 'chat-head' })
  const log = el('ol', { class: 'chat-log', 'aria-label': 'Chat' })
  const live = el('div', { class: 'chat-live', 'aria-live': 'polite' })
  const scroll = el('div', { class: 'chat-scroll' }, el('div', { class: 'chat-column' }, log, live))
  const thumbs = el('div', { class: 'compose-images' })
  const text = el('textarea', { class: 'compose-text', rows: 1, placeholder: WRITE_HINT, 'aria-label': 'Message to Claude' })
  // the emoji button and its picker over the write box
  const emoji = el('button', { type: 'button', class: 'compose-emoji', title: 'Add an emoji', 'aria-label': 'Add an emoji', 'aria-haspopup': 'dialog' }, el('span', { 'aria-hidden': 'true' }, '🙂'))
  const emojiPanel = el('div', { class: 'emoji-picker', role: 'dialog', 'aria-label': 'Emoji', hidden: true })
  // the app's dim suggestion for the next prompt: shown in the empty box, Tab or the right arrow takes it
  const suggestKey = el('span', { class: 'suggest-key', 'aria-hidden': 'true', hidden: true }, 'Tab')
  const picker = el('input', { type: 'file', multiple: true, hidden: true })
  const attach = el('button', { type: 'button', class: 'compose-attach', title: 'Add images or files', 'aria-label': 'Add images or files' }, icon('M10.5 4.5 5.4 9.6a1.6 1.6 0 0 0 2.3 2.3l5.4-5.4a3 3 0 0 0-4.2-4.2L3.4 7.8a4.4 4.4 0 0 0 6.2 6.2L14 9.6'))
  // kept out of the page: as in the app, a message sent while Claude works waits in the queue with Send now on it
  const queue = el('button', { type: 'button', class: 'compose-queue', title: 'Waits until Claude is done, then goes in' }, 'Queue', icon('M3 4h10M3 8h10M3 12h6'))
  const stop = el('button', { type: 'button', class: 'compose-stop', title: 'Stops Claude’s reply. Messages you queued go in after.', 'aria-label': 'Stop Claude', hidden: true }, el('span', { class: 'stop-square', 'aria-hidden': 'true' }), 'Stop')
  const send = el('button', { type: 'submit', class: 'compose-send primary', 'aria-label': 'Send', title: 'Sends it. While Claude works it waits in the queue, where Send now stops Claude and sends it at once (or press Cmd+Enter)' }, 'Send', icon('M2 8h11M9 4l4 4-4 4'))
  const note = el('span', { class: 'compose-note', role: 'status' })
  // a box Claude waits on sits over the compose row, as in the app, where the side panel never covers it
  const dock = el('div', { class: 'chat-dock', 'aria-live': 'polite' })
  // the "/" menu: the session's own slash commands and skills, as the app's prompt box offers them
  const menu = el('div', { class: 'slash-menu', role: 'listbox', 'aria-label': 'Commands and skills', hidden: true })
  const form = el('form', { class: 'chat-compose' }, dock, menu, emojiPanel, thumbs, el('div', { class: 'compose-row' }, el('div', { class: 'compose-tools' }, emoji, attach), text, suggestKey, stop, el('div', { class: 'compose-buttons' }, send)), el('div', { class: 'compose-bar' }, note), picker)
  const side = el('aside', { class: 'chat-side', 'aria-label': 'What the card tells' })
  const body = el('div', { class: 'chat-body' }, el('div', { class: 'chat-main' }, scroll, form), side)
  const root = el('article', { class: `glass tile expanded-tile${context.isSideHidden(sessionId) ? ' side-hidden' : ''}`, 'data-session': sessionId, 'data-ghost': 'light' }, head, body, el('span', { class: 'grip grip-x', 'data-axis': 'x', 'aria-hidden': 'true' }), el('span', { class: 'grip grip-y', 'data-axis': 'y', 'aria-hidden': 'true' }), el('span', { class: 'grip', 'aria-hidden': 'true' }), el('span', { class: 'grip grip-bl', 'data-axis': 'corner-bl', 'aria-hidden': 'true' }), el('span', { class: 'grip grip-tr', 'data-axis': 'corner-tr', 'aria-hidden': 'true' }), el('span', { class: 'grip grip-tl', 'data-axis': 'corner-tl', 'aria-hidden': 'true' }))
  const chat = { id: sessionId, root, head, log, live, dock, scroll, thumbs, text, queue, send, stop, note, side, form, menu, emojiPicker: emojiPanel, suggestKey, suggestion: '', slash: { list: null, at: 0, shown: [], index: 0 }, images: [], files: [], items: [], signature: '', timer: 0, isSending: false, isFollowing: true, canSend: false, problem: '', openSteps: new Set(), openGroups: new Set(), openPrompts: new Set(), steps: new Map(), drafts: new Map(), approvals: new Map() }

  // hovering the panel leaves the wheel to the page; a click in it lets the wheel scroll the panel,
  // until a click somewhere else or Esc
  side.addEventListener('pointerdown', () => side.classList.add('is-scrolling'))
  // a narrow window slides the panel in over the chat: it stops above the write box, never over it
  new ResizeObserver(() => keepSideAboveCompose(chat)).observe(form)

  attach.addEventListener('click', () => picker.click())
  picker.addEventListener('change', () => {
    for (const file of picker.files) addFile(chat, file)
    picker.value = ''
  })
  // words written and not sent yet come back after a reload
  text.value = C.draftOf(drafts(), sessionId, Date.now())
  if (text.value) requestAnimationFrame(() => grow(text))
  text.addEventListener('input', event => {
    typeEmoji(chat, event)
    saveDraftSoon(chat)
    grow(text)
    showSlashMenu(chat)
    showSuggestion(chat)
  })
  emoji.addEventListener('click', () => toggleEmojiPicker(chat))
  text.addEventListener('blur', () => setTimeout(() => hideSlashMenu(chat), 150))
  text.addEventListener('keydown', event => {
    if (slashKey(chat, event)) return
    if (takeSuggestion(chat, event)) return
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      sendMessage(chat, C.enterMode(Boolean(context.sessionOf(chat.id)?.turn?.isRunning), event.metaKey || event.ctrlKey))
    }
  })
  text.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.items ?? [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean)
    if (files.length === 0) return
    event.preventDefault()
    for (const file of files) addFile(chat, file)
  })
  form.addEventListener('submit', event => {
    event.preventDefault()
    sendMessage(chat, C.enterMode(Boolean(context.sessionOf(chat.id)?.turn?.isRunning), false))
  })
  queue.addEventListener('click', () => sendMessage(chat, 'queue'))
  stop.addEventListener('click', async () => {
    stop.disabled = true
    say(chat, (await stopTurn(chat.id)) ? 'Stopping Claude…' : 'Could not stop it. Is the board still running?')
    setTimeout(() => {
      stop.disabled = false
    }, 3000)
  })
  root.addEventListener('dragover', event => {
    if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return
    event.preventDefault()
    root.classList.add('dropping')
  })
  root.addEventListener('dragleave', event => {
    if (!root.contains(event.relatedTarget)) root.classList.remove('dropping')
  })
  root.addEventListener('drop', event => {
    if (![...(event.dataTransfer?.types ?? [])].includes('Files')) return
    event.preventDefault()
    root.classList.remove('dropping')
    for (const file of event.dataTransfer?.files ?? []) addFile(chat, file)
  })
  scroll.addEventListener('scroll', () => {
    // a card moved on the board starts its scroll over at 0 without the person asking: not a choice
    if (scroll.scrollTop === 0 && chat.top > 0 && !chat.isScrolledByHand) return
    chat.isFollowing = L.isAtBottom(scroll)
    chat.top = scroll.scrollTop
  })
  scroll.addEventListener('wheel', () => markHand(chat), { passive: true })
  scroll.addEventListener('pointerdown', () => markHand(chat))
  scroll.addEventListener('keydown', () => markHand(chat))
  return chat
}

// ---------- emoji ----------

/** As the person types: a space after an emoticon, or the closing colon of a :shortcode:, makes it an emoji. */
function typeEmoji(chat, event) {
  if (event.inputType !== 'insertText' || (event.data !== ' ' && event.data !== ':')) return
  const box = chat.text
  const caret = box.selectionStart
  const isSpace = event.data === ' '
  const done = C.emojifyAt(box.value, isSpace ? caret - 1 : caret)
  if (!done) return
  box.value = done.text
  const at = done.caret + (isSpace ? 1 : 0)
  box.setSelectionRange(at, at)
}

/** Opens or closes the picker: a search box and the emoji under it, a click puts one where the cursor is. */
function toggleEmojiPicker(chat) {
  const picker = chat.emojiPicker
  if (!picker.hidden) {
    picker.hidden = true
    return
  }
  const search = el('input', { type: 'search', class: 'emoji-search', placeholder: 'Search emoji', 'aria-label': 'Search emoji' })
  const grid = el('div', { class: 'emoji-grid', role: 'listbox' })
  const draw = () =>
    grid.replaceChildren(
      ...C.findEmoji(search.value).map(([glyph, code]) => {
        const pick = el('button', { type: 'button', class: 'emoji-pick', title: `:${code}:`, 'aria-label': code.replace(/_/g, ' ') }, glyph)
        pick.addEventListener('click', () => insertEmoji(chat, glyph))
        return pick
      }),
    )
  search.addEventListener('input', draw)
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      picker.hidden = true
      chat.text.focus()
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const first = C.findEmoji(search.value)[0]
      if (first) insertEmoji(chat, first[0])
    }
  })
  draw()
  picker.replaceChildren(search, grid)
  picker.hidden = false
  search.focus()
  // a click anywhere else closes it
  const away = event => {
    if (picker.contains(event.target) || event.target.closest?.('.compose-emoji')) return
    picker.hidden = true
    document.removeEventListener('pointerdown', away)
  }
  document.addEventListener('pointerdown', away)
}

/** Puts an emoji where the cursor was in the write box, and closes the picker. */
function insertEmoji(chat, glyph) {
  const box = chat.text
  const start = box.selectionStart ?? box.value.length
  const end = box.selectionEnd ?? start
  box.value = `${box.value.slice(0, start)}${glyph}${box.value.slice(end)}`
  chat.emojiPicker.hidden = true
  box.focus()
  box.setSelectionRange(start + glyph.length, start + glyph.length)
  saveDraftSoon(chat)
  grow(box)
  showSuggestion(chat)
}

// ---------- the suggested next prompt ----------

const WRITE_HINT = 'Write to Claude… Enter sends, Shift+Enter makes a new line'

/** The suggestion shows dim in the box while it is empty, with Tab beside it; else the box's own hint. */
function showSuggestion(chat) {
  const isShown = Boolean(chat.suggestion) && chat.text.value === '' && !chat.text.disabled
  chat.text.placeholder = isShown ? chat.suggestion : WRITE_HINT
  chat.text.classList.toggle('has-suggestion', isShown)
  chat.suggestKey.hidden = !isShown
}

/** Tab, or the right arrow in the empty box, takes the suggestion into the box to edit or send. */
function takeSuggestion(chat, event) {
  const isKey = event.key === 'Tab' || event.key === 'ArrowRight'
  if (!isKey || event.shiftKey || event.isComposing || !chat.suggestion || chat.text.value !== '') return false
  event.preventDefault()
  chat.text.value = chat.suggestion
  chat.text.setSelectionRange(chat.text.value.length, chat.text.value.length)
  saveDraftSoon(chat)
  grow(chat.text)
  showSuggestion(chat)
  return true
}

// ---------- the session's model, effort and mode ----------

// a rock, for caveman mode
const CAVEMAN_ICON = 'M2.5 12 4 7.5 7 5l4 .5 2.5 3.5-.5 3zM7 5l1 3.5 5.5.5M8 8.5 6 12'
const CAVEMAN_LAST_KEY = 'ccc.cavemanLevel'

function lastCavemanLevel() {
  try {
    return localStorage.getItem(CAVEMAN_LAST_KEY) ?? ''
  } catch {
    return ''
  }
}

/** Switches the session's caveman mode on the server; the session's mod tells Claude with the next message. */
async function switchCaveman(chat, level, button) {
  button.disabled = true
  const isDone = await context.setCaveman(chat.id, level)
  button.disabled = false
  if (isDone && level !== 'off') {
    try {
      localStorage.setItem(CAVEMAN_LAST_KEY, level)
    } catch {
      // the rock button turns it on at full next time
    }
  }
  say(chat, isDone ? (level === 'off' ? 'Caveman mode off, from your next message on.' : `Caveman mode ${level}, from your next message on.`) : 'Could not switch caveman mode. Is the board still running?')
  chat.headSignature = ''
  drawHead(chat, context.sessionOf(chat.id))
}

function cavemanRow(chat, choices) {
  const caveman = context.cavemanOf?.(chat.id)
  if (!caveman) return null
  const row = choices('Caveman', C.CAVEMAN_LEVELS, caveman.level, (level, button) => switchCaveman(chat, level, button))
  row.lastChild.append(el('span', { class: 'setup-note' }, caveman.isOwn ? 'Set for this session.' : 'Follows the default in Settings, Board.'))
  return row
}

function toggleSetup(chat) {
  chat.isSetupOpen = !chat.isSetupOpen
  chat.headSignature = ''
  if (!chat.isSetupOpen) chat.setup?.remove()
  drawHead(chat, context.sessionOf(chat.id))
}

/**
 * The panel under the header where the person sets the session's model and effort, as the app's
 * pickers do: each pick runs /model or /effort in the session, at once when it is idle, else once
 * Claude is done. The permission mode is shown, and where to change it: no plugin can switch it.
 */
async function drawSetup(chat, session) {
  const facts = C.sessionSetup(session)
  const { models } = await sessionCommands(chat)
  if (!chat.isSetupOpen) return
  const choices = (label, options, current, run) =>
    el(
      'div',
      { class: 'setup-row' },
      el('span', { class: 'setup-label' }, label),
      el(
        'div',
        { class: 'setup-choices', role: 'group', 'aria-label': label },
        ...options.map(option => {
          const isOn = C.sameChoice(option, current)
          const button = el('button', { type: 'button', class: `setup-choice${isOn ? ' on' : ''}`, 'aria-pressed': String(isOn) }, option)
          button.addEventListener('click', () => run(option, button))
          return button
        }),
      ),
    )
  const send = async (words, button) => {
    button.disabled = true
    const isSent = await sendCommand(chat, words)
    const waits = isSent && isWorkingNow(context.sessionOf(chat.id))
    say(chat, isSent ? (waits ? `${words} goes in once Claude is done with this turn.` : `${words} sent.`) : 'Could not send it. Is the board still running?')
    setTimeout(() => {
      button.disabled = false
    }, 1500)
  }
  const link = L.openLink(session)
  const panel = el(
    'div',
    { class: 'chat-setup glass', role: 'dialog', 'aria-label': 'Session settings' },
    choices('Model', C.modelChoices(models), facts.modelId, (model, button) => send(`/model ${model}`, button)),
    choices('Effort', C.EFFORTS, facts.effort, (effort, button) => send(`/effort ${effort}`, button)),
    cavemanRow(chat, choices),
    el(
      'div',
      { class: 'setup-row' },
      el('span', { class: 'setup-label' }, 'Mode'),
      el(
        'div',
        { class: 'setup-mode' },
        el('strong', {}, facts.mode || 'not known yet'),
        el('span', { class: 'setup-note' }, 'A running session’s mode can only be changed where it runs: the mode menu by the prompt box in the Claude app, or Shift+Tab in a terminal.'),
        link ? el('a', { class: 'open-link', href: link.href, title: link.about }, 'Open it there', icon('M9 2h5v5M14 2 7 9', 11)) : null,
      ),
    ),
  )
  chat.setup?.remove()
  chat.setup = panel
  chat.head.after(panel)
}

// the steps cards the person closed, by session, kept in the browser across reloads
const DRAFTS_KEY = 'ccc.drafts'
const DRAFT_SAVE_MS = 300

function drafts() {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}') ?? {}
  } catch {
    return {}
  }
}

/** Keeps what is in the write box, so it is still there after the board reloads; sent words go. */
function saveDraft(chat) {
  clearTimeout(chat.draftTimer)
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(C.keepDraft(drafts(), chat.id, chat.text.value, Date.now())))
  } catch {
    // a browser that keeps nothing: the words stay until the board reloads
  }
}

function saveDraftSoon(chat) {
  clearTimeout(chat.draftTimer)
  chat.draftTimer = setTimeout(() => saveDraft(chat), DRAFT_SAVE_MS)
}

// whatever was typed last goes in before the page reloads or closes
window.addEventListener('pagehide', () => {
  for (const chat of chats.values()) saveDraft(chat)
})

const CLOSED_PLANS_KEY = 'ccc.closedPlans'

function closedPlans() {
  try {
    return JSON.parse(localStorage.getItem(CLOSED_PLANS_KEY) ?? '{}') ?? {}
  } catch {
    return {}
  }
}

function keepClosedPlans(closed) {
  try {
    localStorage.setItem(CLOSED_PLANS_KEY, JSON.stringify(closed))
  } catch {
    // a browser that keeps nothing still closes the card until the board is loaded again
  }
}

/** Asks the board's server to send a waiting message now; false when it could not. */
async function hurry(sessionId, messageId) {
  try {
    const response = await fetch('/api/hurry', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CCC-Action': 'hurry' }, body: JSON.stringify({ sessionId, id: messageId }) })
    const answer = response.ok ? await response.json() : { ok: false }
    return answer.ok === true
  } catch {
    return false
  }
}

/** Sends a slash command to the session, queued as a message is: it runs as if typed there. */
async function sendCommand(chat, words) {
  try {
    const response = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CCC-Action': 'send' },
      body: JSON.stringify({ sessionId: chat.id, text: words, mode: 'queue', images: [] }),
    })
    const answer = response.ok ? await response.json().catch(() => ({ ok: true })) : { ok: false }
    if (answer.ok === false) return false
    chat.signature = ''
    refresh(chat)
    return true
  } catch {
    return false
  }
}

// ---------- the "/" menu ----------

// how long the session's command list is kept before it is asked for again
const COMMANDS_FRESH_MS = 30_000
const SLASH_SHOWN = 12

/** The session's slash commands and the models /model takes, asked of the board's server now and then. */
async function sessionCommands(chat) {
  if (chat.slash.list && Date.now() - chat.slash.at < COMMANDS_FRESH_MS) return chat.slash.list
  try {
    const response = await fetch(`/api/commands?session=${encodeURIComponent(chat.id)}`, { cache: 'no-store' })
    const data = response.ok ? await response.json() : null
    chat.slash.list = { commands: Array.isArray(data?.commands) ? data.commands : [], models: Array.isArray(data?.models) ? data.models : [] }
    chat.slash.at = Date.now()
  } catch {
    chat.slash.list ??= { commands: [], models: [] }
  }
  return chat.slash.list
}

/** Opens the menu while the first word typed starts with "/", narrowed to what matches it. */
async function showSlashMenu(chat) {
  const typed = C.slashTyped(chat.text.value)
  if (typed === null) return hideSlashMenu(chat)
  const { commands } = await sessionCommands(chat)
  if (C.slashTyped(chat.text.value) !== typed) return
  chat.slash.shown = C.matchCommands(commands, typed).slice(0, SLASH_SHOWN)
  chat.slash.index = Math.min(chat.slash.index, Math.max(0, chat.slash.shown.length - 1))
  if (chat.slash.shown.length === 0) {
    chat.menu.replaceChildren(el('div', { class: 'slash-empty' }, commands.length ? 'No command or skill by that name' : 'No commands yet: they come once this session has loaded the newest CCC'))
    chat.menu.hidden = false
    return
  }
  chat.menu.replaceChildren(
    ...chat.slash.shown.map((command, index) => {
      const row = el(
        'div',
        { class: `slash-item${index === chat.slash.index ? ' active' : ''}`, role: 'option', 'aria-selected': String(index === chat.slash.index) },
        el('span', { class: 'slash-name' }, `/${command.name}`),
        el('span', { class: 'slash-about' }, command.description),
        el('span', { class: 'slash-source' }, C.commandKind(command)),
      )
      row.addEventListener('mousedown', event => {
        event.preventDefault()
        pickCommand(chat, command)
      })
      return row
    }),
  )
  chat.menu.hidden = false
  chat.menu.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
}

function hideSlashMenu(chat) {
  chat.menu.hidden = true
  chat.slash.index = 0
}

/** Puts the picked command in the box, ready for what goes after it. */
function pickCommand(chat, command) {
  chat.text.value = `/${command.name} `
  saveDraftSoon(chat)
  hideSlashMenu(chat)
  chat.text.focus()
  grow(chat.text)
}

/** Arrows move through the open menu, Enter or Tab picks, Esc closes it; true when the key was the menu's. */
function slashKey(chat, event) {
  if (chat.menu.hidden || event.isComposing) return false
  const count = chat.slash.shown.length
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    hideSlashMenu(chat)
    return true
  }
  if (!count) return false
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    chat.slash.index = (chat.slash.index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count
    showSlashMenu(chat)
    return true
  }
  if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
    event.preventDefault()
    pickCommand(chat, chat.slash.shown[chat.slash.index])
    return true
  }
  return false
}

/** Folds the panel of facts in or out; the chat takes the room it leaves. */
function toggleSide(chat) {
  const isHidden = chat.root.classList.toggle('side-hidden')
  chat.headSignature = ''
  drawHead(chat, context.sessionOf(chat.id))
  context.onSide(chat.id, isHidden)
}

function grow(text) {
  text.style.height = 'auto'
  text.style.height = `${Math.min(text.scrollHeight, window.innerHeight * 0.32)}px`
  placeButtons(text)
}

// past two lines (60px tall) the box has grown: its buttons go down to the last line
const TALL_FROM = 70
const SLIDE_MS = 160

/**
 * The buttons beside the box sit in the middle of its two lines, and at its bottom once it grows.
 * They slide there rather than jump.
 */
function placeButtons(text) {
  const row = text.parentElement
  if (!row?.classList.contains('compose-row') || !text.isConnected) return
  const isTall = text.offsetHeight > TALL_FROM
  if (row.classList.contains('is-tall') === isTall) return
  const moving = [...row.children].filter(node => node !== text && !node.hidden)
  const before = moving.map(node => node.getBoundingClientRect().top)
  row.classList.toggle('is-tall', isTall)
  if (document.body.classList.contains('motion-off')) return
  moving.forEach((node, i) => {
    const shift = before[i] - node.getBoundingClientRect().top
    if (Math.abs(shift) > 0.5) node.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], { duration: SLIDE_MS, easing: 'ease-out' })
  })
}

function drawHead(chat, session) {
  const id = chat.id
  const title = context.titleOf(id) ?? session?.folder ?? 'Session'
  const state = session ? L.sessionState(session, Date.now()) : 'ended'
  const source = L.sourceOf(session)
  const link = L.openLink(session)
  const facts = C.sessionSetup(session)
  const caveman = context.cavemanOf?.(id) ?? { level: 'off', isOwn: false }
  const signature = JSON.stringify([title, state, source?.label, link?.href, session?.folder, session?.branch, context.colorOf(id), facts, caveman])
  if (signature === chat.headSignature) return
  chat.headSignature = signature
  const close = el('button', { type: 'button', class: 'chat-close chat-remove', 'aria-label': `Close ${title}`, title: 'Close: from CCC only, or clear its context too' }, icon('M4 4l8 8M12 4l-8 8'))
  close.addEventListener('click', () => context.onRemove(id, title))
  const isHidden = chat.root.classList.contains('side-hidden')
  const panel = el(
    'button',
    { type: 'button', class: 'chat-close side-toggle', 'aria-pressed': String(!isHidden), 'aria-label': isHidden ? 'Show the card’s facts' : 'Hide the card’s facts', title: isHidden ? 'Show the facts panel' : 'Hide the facts panel' },
    icon(isHidden ? 'M2.5 3h11v10h-11zM10 3v10M6 6.5 7.5 8 6 9.5' : 'M2.5 3h11v10h-11zM10 3v10M7.5 6.5 6 8l1.5 1.5'),
  )
  panel.addEventListener('click', () => toggleSide(chat))
  const setup = el(
    'button',
    { type: 'button', class: 'setup-toggle', 'aria-haspopup': 'dialog', 'aria-expanded': String(Boolean(chat.isSetupOpen)), title: 'Model, effort and mode of this session' },
    icon('M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7M10.5 3v3M5.5 10v3'),
    el('span', {}, [L.modelName(facts.modelId), facts.effort, facts.mode].filter(Boolean).join(' · ') || 'Session settings'),
  )
  setup.addEventListener('click', () => toggleSetup(chat))
  const isCaveman = caveman.level !== 'off'
  const rock = el(
    'button',
    {
      type: 'button',
      class: 'chat-close caveman-toggle',
      'aria-pressed': String(isCaveman),
      'aria-label': isCaveman ? `Caveman mode is on (${caveman.level}). Switch it off` : 'Switch caveman mode on',
      title: isCaveman
        ? `Caveman mode: ${caveman.level}. Claude answers tersely to save tokens. Click to switch it off; pick the level in the session settings.`
        : 'Caveman mode: off. Click for terse answers that save tokens, from your next message on.',
    },
    icon(CAVEMAN_ICON),
  )
  rock.addEventListener('click', () => switchCaveman(chat, C.cavemanToggled(caveman.level, lastCavemanLevel()), rock))
  const parts = [
    el('span', { class: 'dot', style: `background:${context.colorOf(id)}`, 'aria-hidden': 'true' }),
    el('span', { class: 'chat-title' }, title),
    source ? el('span', { class: `source source-${source.kind}` }, source.label) : null,
    el('span', { class: 'chat-where' }, [session?.folder, session?.branch].filter(Boolean).join(' · ')),
    el('span', { class: `pill ${state === 'working' ? 'pill-work live' : state === 'needs-you' ? 'pill-wait' : 'pill-done'}` }, L.STATE_LABEL[state] ?? state),
    link ? el('a', { class: 'open-link', href: link.href, title: link.about }, 'Open', icon('M9 2h5v5M14 2 7 9', 11)) : null,
    setup,
    rock,
    panel,
    close,
  ]
  chat.head.replaceChildren(...parts.filter(Boolean))
  if (chat.isSetupOpen) drawSetup(chat, session)
  chat.root.setAttribute('aria-label', `Chat: ${title}`)
}

// ---------- the history ----------

async function refresh(chat) {
  let data
  try {
    const response = await fetch(`/api/chat?session=${encodeURIComponent(chat.id)}`, { cache: 'no-store' })
    if (!response.ok) return
    data = await response.json()
  } catch {
    return
  }
  if (!chats.has(chat.id)) return
  keepSideAboveCompose(chat)
  const signature = JSON.stringify(data)
  if (signature === chat.signature) return
  chat.signature = signature
  chat.items = Array.isArray(data.items) ? data.items : []
  const pending = Array.isArray(data.pending) ? data.pending : []
  const wasFollowing = chat.isFollowing !== false
  // words being written in a question box keep their place and focus across the redraw
  const writing = document.activeElement?.matches?.('.q-other') && chat.log.contains(document.activeElement) ? document.activeElement : null
  const writingAt = writing ? { box: writing.closest('[data-box]')?.dataset.box, index: writing.dataset.index, caret: writing.selectionStart } : null
  chat.log.replaceChildren(...C.groupSteps(C.shownItems(chat.items, context.showsNotes?.())).map(item => drawItem(chat, item)), ...pending.map(message => drawPending(chat, message)))
  if (writingAt?.box) {
    const again = chat.log.querySelector(`[data-box="${CSS.escape(writingAt.box)}"] .q-other[data-index="${writingAt.index}"]`)
    again?.focus()
    again?.setSelectionRange(writingAt.caret, writingAt.caret)
  }
  if (chat.items.length === 0 && pending.length === 0) chat.log.append(el('li', { class: 'msg msg-note' }, 'Nothing in this chat yet.'))
  chat.liveSignature = ''
  drawLive(chat, context.sessionOf(chat.id))
  for (const toolId of chat.openSteps) if (!chat.steps.get(toolId)?.isDone) loadStep(chat, toolId)
  if (wasFollowing) chat.scroll.scrollTop = chat.scroll.scrollHeight
}

function drawItem(chat, item) {
  if (item.kind === 'you') {
    const pictures = item.pictures?.length ? drawPictures(chat, item.pictures) : null
    const count = !pictures && item.images ? el('span', { class: 'msg-bubble-images' }, item.images === 1 ? '1 image' : `${item.images} images`) : null
    const files = item.files?.length ? el('div', { class: 'msg-files' }, ...item.files.map(name => el('span', { class: 'msg-file' }, icon('M9 1.5H4a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V6L9 1.5zM9 1.5V6h4.5', 13), name))) : null
    return el(
      'li',
      { class: `msg msg-you${item.queued ? ' pending' : ''}` },
      el('div', { class: 'msg-bubble' }, item.text ? promptText(chat, item.text) : null, files, pictures, count),
      item.queued ? queuedNote(chat, 'queued, goes in when Claude is done') : null,
    )
  }
  if (item.kind === 'image') return el('li', { class: 'msg msg-images', 'aria-label': 'Images Claude looked at' }, drawPictures(chat, item.pictures, true))
  if (item.kind === 'claude') return el('li', { class: 'msg msg-claude' }, el('span', { class: 'claude-mark', 'aria-hidden': 'true' }, '✻'), markdown(item.text))
  if (item.kind === 'steps') return drawSteps(chat, item.steps, item.pictures)
  if (item.kind === 'question') return drawQuestion(chat, item)
  return el('li', { class: 'msg msg-note' }, item.text)
}

/**
 * What the person wrote, as the app shows it: a long prompt is cut down to its first lines with
 * Show more under it, and stays open once opened, through every redraw, until Show less.
 */
function promptText(chat, text) {
  const words = String(text ?? '')
  const body = el('div', { class: 'prompt-text' }, words)
  if (!C.isLongPrompt(words)) return body
  const key = C.promptKey(words)
  const isOpen = chat.openPrompts.has(key)
  body.classList.toggle('clamped', !isOpen)
  const more = el('button', { type: 'button', class: 'show-more', 'aria-expanded': String(isOpen) }, isOpen ? 'Show less' : 'Show more')
  more.addEventListener('click', () => {
    const opening = !chat.openPrompts.has(key)
    if (opening) chat.openPrompts.add(key)
    else chat.openPrompts.delete(key)
    body.classList.toggle('clamped', !opening)
    more.textContent = opening ? 'Show less' : 'Show more'
    more.setAttribute('aria-expanded', String(opening))
  })
  return el('div', { class: 'prompt' }, body, more)
}

/** How long a sent answer may wait for Claude to take it before the window says to answer in the app. */
const SENT_PATIENCE_MS = 20_000

/**
 * A question box Claude put to the person, as the app shows it: each question with its options,
 * and once answered what was picked. While it waits, a session in the Claude app or VS Code can
 * be answered right here (the box in the app is then taken down); any other is answered where it runs.
 */
function drawQuestion(chat, item) {
  const state = item.answers ? 'answered' : item.isDeclined ? 'declined' : 'open'
  const session = context.sessionOf(chat.id)
  const link = state === 'open' ? L.openLink(session) : null
  const canAnswer = state === 'open' && Boolean(item.toolId) && C.ANSWERS_FROM_CCC.has(session?.entrypoint)
  const badge = { open: 'Question for you', answered: 'You answered', declined: 'Not answered' }[state]
  const node = el('li', { class: `msg msg-question q-${state}`, 'data-box': item.toolId ?? '' })
  if (!canAnswer) {
    const where = session?.entrypoint === 'cli' ? 'Answer it in the terminal' : 'Answer it in the Claude app'
    node.append(
      el(
        'div',
        { class: 'q-card' },
        el('div', { class: 'q-badge' }, badge),
        (item.questions ?? []).map((question, i) => drawOneQuestion(question, item.answers?.[i])),
        state === 'open' ? el('div', { class: 'q-foot' }, el('span', {}, where), openLink(link)) : null,
      ),
    )
    return node
  }
  if (!chat.drafts.has(item.toolId)) chat.drafts.set(item.toolId, C.emptyDraft(item.questions))
  const draft = chat.drafts.get(item.toolId)
  const isLocked = draft.state === 'sending' || draft.state === 'sent'
  const send = el('button', { type: 'button', class: 'q-send', disabled: isLocked || !C.isDraftReady(item.questions, draft) }, draft.state === 'sending' ? 'Sending…' : 'Send answer')
  const redraw = focusIndex => {
    const next = drawQuestion(chat, item)
    node.replaceWith(next)
    if (focusIndex !== undefined) next.querySelector(`.q-other[data-index="${focusIndex}"]`)?.focus()
  }
  const change = (i, part, focusOther) => {
    draft.parts[i] = part
    draft.problem = ''
    redraw(focusOther && part.isOther ? i : undefined)
  }
  const typed = () => {
    send.disabled = !C.isDraftReady(item.questions, draft)
  }
  send.addEventListener('click', () => sendAnswer(chat, item, draft, redraw))
  node.append(
    el(
      'div',
      { class: 'q-card' },
      el('div', { class: 'q-badge' }, badge),
      item.questions.map((question, i) => drawAnswerable(question, draft.parts[i], i, isLocked, change, typed)),
      el('div', { class: 'q-foot' }, el('span', { class: `q-status${draft.problem ? ' problem' : ''}`, role: 'status' }, answerStatus(draft)), el('span', { class: 'q-actions' }, openLink(link, 'Open in the app'), send)),
    ),
  )
  return node
}

/** One question to answer here: its options to click, and Other for words of the person's own. */
function drawAnswerable(question, part, index, isLocked, change, typed) {
  const role = question.multiSelect ? 'checkbox' : 'radio'
  const option = (label, description, isChosen, onClick) => {
    const button = el(
      'button',
      { type: 'button', role, class: `q-option${isChosen ? ' chosen' : ''}`, 'aria-checked': String(isChosen), disabled: isLocked },
      el('span', { class: 'q-mark', 'aria-hidden': 'true' }),
      el('span', { class: 'q-option-text' }, el('span', { class: 'q-label' }, label), description ? el('span', { class: 'q-desc' }, description) : null),
    )
    button.addEventListener('click', onClick)
    return button
  }
  const other = part.isOther ? el('textarea', { class: 'q-other', 'data-index': index, rows: 2, placeholder: 'Write your own answer', 'aria-label': `Your own answer to: ${question.question}`, disabled: isLocked }) : null
  if (other) {
    other.value = part.other
    other.addEventListener('input', () => {
      part.other = other.value
      typed()
    })
  }
  return el(
    'div',
    { class: 'q-one' },
    el('div', { class: 'q-text' }, question.header ? el('span', { class: 'q-header' }, question.header) : null, question.question),
    question.multiSelect ? el('div', { class: 'q-hint' }, 'Pick one or more') : null,
    el(
      'div',
      { class: `q-options${question.multiSelect ? ' many' : ''}`, role: question.multiSelect ? 'group' : 'radiogroup', 'aria-label': question.question },
      question.options.map(choice => option(choice.label, choice.description, part.picks.includes(choice.label), () => change(index, C.pickOption(question, part, choice.label)))),
      option('Other', 'Write your own answer', part.isOther, () => change(index, C.chooseOther(question, part), true)),
    ),
    other,
  )
}

function answerStatus(draft) {
  if (draft.problem) return draft.problem
  if (draft.state === 'sending') return 'Sending your answer…'
  if (draft.state === 'sent') {
    return Date.now() - draft.sentAt < SENT_PATIENCE_MS ? 'Sent. Claude takes it in a moment.' : 'Claude has not taken it. Answer it in the Claude app instead.'
  }
  return 'Pick an answer here, or answer in the app.'
}

function openLink(link, label = 'Open') {
  return link ? el('a', { class: 'open-link', href: link.href, title: link.about }, label, icon('M9 2h5v5M14 2 7 9', 11)) : null
}

/** Leaves the answer for the session's hook, which hands it to Claude and takes the box down in the app. */
async function sendAnswer(chat, item, draft, redraw) {
  if (draft.state !== 'editing' || !C.isDraftReady(item.questions, draft)) return
  draft.state = 'sending'
  redraw()
  try {
    const response = await fetch('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CCC-Action': 'answer' },
      body: JSON.stringify({ sessionId: chat.id, toolId: item.toolId, answers: item.questions.map((question, i) => C.answerText(question, draft.parts[i])) }),
    })
    const result = response.ok ? await response.json() : { problem: 'Could not send it. Is the board still running?' }
    if (result.problem) {
      draft.state = 'editing'
      draft.problem = result.problem
    } else {
      draft.state = 'sent'
      draft.sentAt = Date.now()
      // after a while the window says so if Claude has not taken the answer
      setTimeout(() => {
        chat.signature = ''
      }, SENT_PATIENCE_MS + 100)
    }
  } catch {
    draft.state = 'editing'
    draft.problem = 'Could not send it. Is the board still running?'
  }
  if (chats.has(chat.id)) {
    const current = chat.log.querySelector(`[data-box="${CSS.escape(item.toolId)}"]`)
    if (current) current.replaceWith(drawQuestion(chat, item))
  }
}

function drawOneQuestion(question, answer) {
  const chosen = C.chosenOptions(question, answer)
  const ownWords = answer && chosen.size === 0 ? answer : ''
  return el(
    'div',
    { class: 'q-one' },
    el('div', { class: 'q-text' }, question.header ? el('span', { class: 'q-header' }, question.header) : null, question.question),
    question.multiSelect ? el('div', { class: 'q-hint' }, 'Pick one or more') : null,
    question.options.length
      ? el(
          'ul',
          { class: `q-options${question.multiSelect ? ' many' : ''}` },
          question.options.map(option =>
            el(
              'li',
              { class: `q-option${chosen.has(option.label) ? ' chosen' : ''}` },
              el('span', { class: 'q-mark', 'aria-hidden': 'true' }),
              el('span', { class: 'q-option-text' }, el('span', { class: 'q-label' }, option.label), option.description ? el('span', { class: 'q-desc' }, option.description) : null),
              chosen.has(option.label) ? el('span', { class: 'visually-hidden' }, ' (picked)') : null,
            ),
          ),
        )
      : null,
    ownWords ? el('div', { class: 'q-answer' }, el('span', { class: 'q-answer-label' }, 'Your answer'), ownWords) : null,
  )
}

/** Small images, each opening in full in a tab of its own; `isThumb` draws them as the app's tiny thumbnails. */
function drawPictures(chat, refs, isThumb = false) {
  const shown = isThumb ? refs.slice(-THUMBS_SHOWN) : refs
  const more = refs.length - shown.length
  return el(
    'div',
    { class: `msg-pictures${isThumb ? ' thumbs' : ''}` },
    more > 0 ? el('span', { class: 'thumbs-more', title: `${more} more` }, `+${more}`) : null,
    shown.map(ref => {
      const url = `/api/picture?session=${encodeURIComponent(chat.id)}&ref=${encodeURIComponent(ref)}`
      // loaded at once: a lazy image starts with no size inside the chat's own scroll and is never asked for
      return el('a', { class: 'msg-picture', href: url, target: '_blank', rel: 'noopener', title: 'Open the image in full' }, el('img', { src: url, alt: '', decoding: 'async' }))
    }),
  )
}

// the pictures a run of steps brought back show as at most this many thumbnails, the newest
const THUMBS_SHOWN = 3

/**
 * A run of steps, folded under one line that sums them up as the app does; opened, each step in turn.
 * A screenshot a step took sits at the end of the line, as a thumbnail that opens it in full.
 */
function drawSteps(chat, steps, pictures) {
  const lines = el('ol', { class: 'steps' }, steps.map(step => drawStep(chat, step)))
  const key = steps[0].toolId ?? steps[0].text
  const summary = C.stepsSummary(steps) || (steps.length === 1 ? '1 step' : `${steps.length} steps`)
  // the lines the steps added and took away, green and red, as the app shows them
  const changed = C.linesChanged(steps)
  const diff = changed
    ? el('span', { class: 'steps-diff', title: `${changed.added} lines added, ${changed.removed} taken away` }, el('span', { class: 'diff-add' }, `+${changed.added}`), el('span', { class: 'diff-del' }, `-${changed.removed}`))
    : null
  const group = el('details', { open: chat.openGroups.has(key) }, el('summary', {}, el('span', { class: 'steps-words' }, summary), diff), lines)
  group.addEventListener('toggle', () => {
    if (group.open) chat.openGroups.add(key)
    else chat.openGroups.delete(key)
  })
  const thumbs = pictures?.length ? drawPictures(chat, pictures, true) : null
  return el('li', { class: `msg msg-steps${thumbs ? ' with-thumbs' : ''}` }, group, thumbs)
}

/** One step: a click shows what it was given and what came back, and stays open as the chat updates. */
function drawStep(chat, step) {
  if (!step.toolId) return el('li', { class: 'step-line' }, el('span', { class: 'step-text' }, step.text))
  const isOpen = chat.openSteps.has(step.toolId)
  const toggle = el('button', { type: 'button', class: 'step-toggle', 'aria-expanded': String(isOpen), title: isOpen ? 'Hide what it gave back' : 'Show the command and what it gave back' }, el('span', { class: 'step-chevron', 'aria-hidden': 'true' }, '▸'), el('span', { class: 'step-text' }, step.text))
  const line = el('li', { class: `step-line${isOpen ? ' open' : ''}` }, toggle)
  toggle.addEventListener('click', () => {
    if (chat.openSteps.has(step.toolId)) chat.openSteps.delete(step.toolId)
    else {
      chat.openSteps.add(step.toolId)
      // reading a step: the chat stays where it is until the person scrolls back down to the newest line
      chat.isFollowing = false
      chat.top = chat.scroll.scrollTop
    }
    line.replaceWith(drawStep(chat, step))
    if (chat.openSteps.has(step.toolId)) loadStep(chat, step.toolId)
  })
  if (isOpen) line.append(drawStepDetail(chat.steps.get(step.toolId), chat, step.toolId))
  line.dataset.tool = step.toolId
  return line
}

function drawStepDetail(step, chat, toolId) {
  if (!step) return el('div', { class: 'step-detail' }, el('span', { class: 'note' }, 'Loading…'))
  if (step.diff) return drawChange(step, chat, toolId)
  return el(
    'div',
    { class: `step-detail${step.isError ? ' failed' : ''}` },
    el('span', { class: 'step-label' }, step.name),
    openFileButton(step, chat, toolId, true),
    el('pre', { class: 'step-input' }, step.input || '(nothing given)'),
    el('span', { class: 'step-label' }, step.isDone ? (step.isError ? 'FAILED' : 'RESULT') : 'STILL RUNNING'),
    step.isDone ? el('pre', { class: 'step-result' }, step.result || '(nothing came back)') : null,
  )
}

const CHANGE_SIGN = { add: '+', del: '-', same: ' ' }

/**
 * The file a step touched, as a button that opens it in the person's editor at the step's line,
 * while the setting for it is on; null when it is off or the step touched no file. `isLine` draws it
 * as a line of its own ("Open b.js in IntelliJ IDEA") under a step's name.
 */
function openFileButton(step, chat, toolId, isLine = false) {
  const editor = context.editorOf?.()
  if (!editor || !step?.filePath || !chat || !toolId) return null
  const name = L.folderLabel(step.filePath).name
  const where = `${editor.name}, line ${step.fileLine ?? 1}`
  const button = el(
    'button',
    { type: 'button', class: `open-file${isLine ? ' open-file-line' : ''}`, title: `Open ${step.filePath} in ${where}` },
    isLine ? `Open ${name} in ${editor.name}` : name,
    icon('M9 2h5v5M14 2 7 9', 10),
  )
  button.addEventListener('click', async event => {
    event.stopPropagation()
    button.disabled = true
    try {
      const response = await fetch('/api/open-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CCC-Action': 'open-file' },
        body: JSON.stringify({ sessionId: chat.id, toolId, editor: editor.id }),
      })
      const answer = response.ok ? await response.json() : { problem: 'Could not open it. Is the board still running?' }
      if (!answer.ok) say(chat, answer.problem || 'Could not open the file.')
    } catch {
      say(chat, 'Could not open it. Is the board still running?')
    } finally {
      button.disabled = false
    }
  })
  return button
}

/**
 * An opened change to a file, as the app shows it: the file, then its lines, the ones taken away in
 * red and the ones added in green, one part per change. A change that failed says why under it.
 */
function drawChange(step, chat, toolId) {
  const { file, parts, isCut } = step.diff
  const lines = parts.flat()
  const added = lines.filter(line => line.kind === 'add').length
  const removed = lines.filter(line => line.kind === 'del').length
  return el(
    'div',
    { class: `step-detail step-change${step.isError ? ' failed' : ''}` },
    el(
      'div',
      { class: 'change-head' },
      // the file's name, and the folder it is in after it, dimmed; with an editor set, the name opens the file in it
      el('span', { class: 'change-file', title: file }, openFileButton(step, chat, toolId) ?? el('span', { class: 'change-name' }, L.folderLabel(file).name || step.name), file ? el('span', { class: 'change-folder' }, L.folderLabel(file).parent) : null),
      el('span', { class: 'steps-diff' }, el('span', { class: 'diff-add' }, `+${added}`), el('span', { class: 'diff-del' }, `-${removed}`)),
    ),
    parts.map(part =>
      el(
        'div',
        { class: 'change-part' },
        part.map(line =>
          el(
            'div',
            { class: `change-line change-${line.kind}` },
            // the line's number in the file, when Claude Code kept where the change sits
            Number.isInteger(line.line) ? el('span', { class: 'change-number', 'aria-hidden': 'true' }, String(line.line)) : null,
            el('span', { class: 'change-sign', 'aria-hidden': 'true' }, CHANGE_SIGN[line.kind] ?? ' '),
            el('span', { class: 'change-text' }, line.text || ' '),
          ),
        ),
      ),
    ),
    isCut ? el('span', { class: 'note' }, 'Only the first 600 lines are shown.') : null,
    step.isError ? el('span', { class: 'step-label' }, 'FAILED') : null,
    step.isError ? el('pre', { class: 'step-result' }, step.result || '(nothing came back)') : null,
    step.isDone ? null : el('span', { class: 'step-label' }, 'STILL RUNNING'),
  )
}

/** Fetches a step's full command and result; one still running is asked again on the next update. */
async function loadStep(chat, toolId) {
  try {
    const response = await fetch(`/api/step?session=${encodeURIComponent(chat.id)}&tool=${encodeURIComponent(toolId)}`, { cache: 'no-store' })
    if (!response.ok) return
    chat.steps.set(toolId, await response.json())
  } catch {
    return
  }
  const line = [...chat.log.querySelectorAll('.step-line.open')].find(node => node.dataset.tool === toolId)
  line?.querySelector('.step-detail')?.replaceWith(drawStepDetail(chat.steps.get(toolId), chat, toolId))
}

function drawPending(chat, message) {
  return el(
    'li',
    { class: 'msg msg-you pending' },
    el('div', { class: 'msg-bubble' }, message.text ? promptText(chat, message.text) : null, message.images ? el('span', { class: 'msg-bubble-images' }, message.images === 1 ? '1 image' : `${message.images} images`) : null, message.files ? el('span', { class: 'msg-bubble-images' }, message.files === 1 ? '1 file' : `${message.files} files`) : null),
    message.mode === 'queue' ? queuedNote(chat, 'queued, goes in when Claude is done', message.id) : el('span', { class: 'pending-note' }, 'going in now…'),
  )
}

/**
 * The note under a queued message, with Send now: Claude stops and the message goes in at once. One
 * still in CCC's inbox (`messageId`) is turned into a send-now message, so it is never lost; one in
 * the session's own queue (written in the app) goes in once Claude has stopped, as on Stop.
 */
function queuedNote(chat, words, messageId) {
  const now = el('button', { type: 'button', class: 'queued-now', title: 'Stops Claude so this goes in now' }, 'Send now')
  now.addEventListener('click', async () => {
    now.disabled = true
    const isGoing = messageId ? await hurry(chat.id, messageId) : await stopTurn(chat.id)
    now.textContent = isGoing ? 'Going in…' : 'Could not send it now'
    chat.signature = ''
    refresh(chat)
  })
  const session = context.sessionOf(chat.id)
  const canHurry = Boolean(session?.takesMessages) && isWorkingNow(session)
  return el('span', { class: 'pending-note' }, words, canHurry ? now : null)
}

function drawLive(chat, session) {
  const isRunning = Boolean(session?.turn?.isRunning)
  const rest = isRunning ? C.liveRemainder(chat.items, session?.reply?.text) : ''
  const activity = session ? L.activityOf(session, Date.now()) : null
  const next = L.openNextStep(session)
  const waiting = session ? L.waitingFor(session) : undefined
  const approval = isRunning ? C.approvalView(waiting) : null
  // the steps card shows while Claude works on the turn that keeps it, and goes once it ends, as in the app
  const plan = isRunning && Array.isArray(session?.plan) ? session.plan : []
  const signature = JSON.stringify([isRunning, rest, activity?.label, activity?.text, session?.reply?.isWriting, next, session?.turn?.endedAt, sentChoices.get(chat.id), approval, chat.approvals.get(approval?.box), plan])
  if (signature === chat.liveSignature) return
  chat.liveSignature = signature
  chat.dock.replaceChildren(...(approval ? [drawApproval(chat, session, approval)] : []))
  // a steps card the person closed stays away until the steps change: a step done, a new one, a new list
  const steps = plan.length && !C.isPlanClosed(closedPlans(), chat.id, plan) ? drawPlan(chat, plan) : null
  if (!isRunning) {
    chat.live.replaceChildren(...[steps, next ? drawNextStep(chat, session, next) : null].filter(Boolean))
    if (next && chat.isFollowing !== false) chat.scroll.scrollTop = chat.scroll.scrollHeight
    return
  }
  const status = el('div', { class: 'live-status' }, el('span', { class: 'running-dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')), ' ', activity?.label ?? 'Working', activity?.text ? el('span', { class: 'live-detail' }, ` · ${activity.text}`) : null)
  const writing = rest ? el('div', { class: 'msg msg-claude' }, el('span', { class: 'claude-mark', 'aria-hidden': 'true' }, '✻'), markdown(rest), session?.reply?.isWriting ? el('span', { class: 'reply-caret', 'aria-hidden': 'true' }) : null) : null
  chat.live.replaceChildren(...[writing, steps, status].filter(Boolean))
  if (chat.isFollowing !== false) chat.scroll.scrollTop = chat.scroll.scrollHeight
}

/**
 * The session's task list, as the app's card shows it under the chat: each step with a ring that
 * spins while it is worked on, a check once done, and a dashed ring while it waits.
 */
function drawPlan(chat, plan) {
  const done = plan.filter(step => step.status === 'completed').length
  const close = el('button', { type: 'button', class: 'plan-close', 'aria-label': 'Close the steps card', title: 'Close: it comes back as soon as the steps change' }, icon('M4 4l8 8M12 4l-8 8', 11))
  close.addEventListener('click', () => {
    keepClosedPlans(C.closePlan(closedPlans(), chat.id, plan))
    chat.liveSignature = ''
    drawLive(chat, context.sessionOf(chat.id))
  })
  return el(
    'div',
    { class: 'chat-plan', role: 'list', 'aria-label': `Steps, ${done} of ${plan.length} done` },
    close,
    ...plan.map(step =>
      el(
        'div',
        { class: `plan-step plan-${step.status}`, role: 'listitem' },
        el('span', { class: 'plan-mark', 'aria-hidden': 'true' }, step.status === 'completed' ? icon('M3.5 8.5l3 3 6-7', 12) : null),
        el('span', { class: 'plan-text' }, step.text),
      ),
    ),
  )
}

/**
 * The approval box Claude waits on, as the app shows it: the question, why it asks and the command
 * or file. While the session's hook holds the box open it is answered right here, Deny or Allow
 * once, and the box in the app is taken down; else it says where to answer.
 */
function drawApproval(chat, session, view) {
  if (view.branch) return drawBranchQuestion(chat, session, view)
  const link = L.openLink(session)
  const draft = chat.approvals.get(view.box)
  const isLocked = draft?.state === 'sending' || draft?.state === 'sent'
  const choice = (decision, label) => {
    const button = el('button', { type: 'button', class: `a-choice a-${decision}${draft?.choice === decision ? ' chosen' : ''}`, disabled: isLocked }, label)
    button.addEventListener('click', () => sendApproval(chat, view.box, decision))
    return button
  }
  const where = session?.entrypoint === 'cli' ? 'Answer it in the terminal' : 'Answer it in the Claude app'
  const foot = view.canAnswer
    ? el('div', { class: 'q-foot' }, el('span', { class: `q-status${draft?.problem ? ' problem' : ''}`, role: 'status' }, C.approvalStatus(draft)), el('span', { class: 'q-actions' }, openLink(link, 'Open in the app'), choice('deny', 'Deny'), choice('allow', 'Allow once')))
    : el('div', { class: 'q-foot' }, el('span', {}, where), openLink(link))
  return el(
    'div',
    { class: 'msg msg-question msg-approval q-open', 'data-approval': view.box },
    el(
      'div',
      { class: 'q-card' },
      el('div', { class: 'q-badge' }, 'Needs approval'),
      el('div', { class: 'a-title' }, view.title),
      view.description ? el('div', { class: 'a-desc' }, view.description) : null,
      view.reason ? el('div', { class: 'a-reason' }, view.reason) : null,
      view.code ? el('pre', { class: 'a-code' }, view.code) : null,
      foot,
    ),
  )
}

/**
 * The Claude app's branch question, as the app draws it: a new branch with the name Claude suggests
 * (picked first, as the app recommends) or the branch checked out now, and Continue.
 */
function drawBranchQuestion(chat, session, view) {
  const link = L.openLink(session)
  const draft = chat.approvals.get(view.box)
  const isLocked = draft?.state === 'sending' || draft?.state === 'sent' || !view.canAnswer
  const picked = draft?.branch ?? draft?.pick ?? 'new'
  // the same round options as the question boxes CCC draws for Claude's own questions
  const option = (value, label, about) => {
    const isChosen = picked === value
    const button = el(
      'button',
      { type: 'button', role: 'radio', class: `q-option${isChosen ? ' chosen' : ''}`, 'aria-checked': String(isChosen), disabled: isLocked },
      el('span', { class: 'q-mark', 'aria-hidden': 'true' }),
      el('span', { class: 'q-option-text' }, el('span', { class: 'q-label' }, label), el('span', { class: 'q-desc' }, about)),
    )
    button.addEventListener('click', () => {
      chat.approvals.set(view.box, { ...chat.approvals.get(view.box), state: 'open', pick: value })
      redrawLive(chat)
    })
    return button
  }
  const go = el('button', { type: 'button', class: 'primary q-send', disabled: isLocked }, 'Continue')
  go.addEventListener('click', () => sendApproval(chat, view.box, 'allow', picked))
  const where = session?.entrypoint === 'cli' ? 'Answer it in the terminal' : 'Answer it in the Claude app'
  const foot = view.canAnswer
    ? el('div', { class: 'q-foot' }, el('span', { class: `q-status${draft?.problem ? ' problem' : ''}`, role: 'status' }, C.approvalStatus(draft)), el('span', { class: 'q-actions' }, openLink(link, 'Open in the app'), go))
    : el('div', { class: 'q-foot' }, el('span', {}, where), openLink(link))
  return el(
    'div',
    { class: 'msg msg-question msg-approval msg-branch q-open', 'data-approval': view.box },
    el(
      'div',
      { class: 'q-card', role: 'radiogroup', 'aria-label': view.title },
      el('div', { class: 'q-badge' }, 'Needs your input'),
      el('div', { class: 'a-title' }, view.title),
      el('div', { class: 'a-desc' }, 'Recommended: your current branch keeps its history until you merge.'),
      el('div', { class: 'q-options' }, option('new', ['New branch ', el('code', {}, view.branch.suggested || 'with a new name')], 'Created in this folder from what’s checked out now; Claude switches to it before changing anything.'),
      option('stay', 'Stay on the current branch', 'Claude commits to the branch that’s checked out now.')),
      foot,
    ),
  )
}

/** Leaves the decision for the session's hook, which hands it to Claude and takes the box down in the app. */
async function sendApproval(chat, box, decision, branch) {
  const draft = { state: 'sending', choice: decision, ...(branch ? { branch } : {}) }
  chat.approvals.set(box, draft)
  redrawLive(chat)
  try {
    const response = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CCC-Action': 'approve' },
      body: JSON.stringify({ sessionId: chat.id, box, decision, ...(branch ? { branch } : {}) }),
    })
    const result = response.ok ? await response.json() : { problem: 'Could not send it. Is the board still running?' }
    // a problem leaves the box open as it was, with the branch the person picked still picked
    chat.approvals.set(box, result.problem ? { state: 'open', problem: result.problem, ...(branch ? { pick: branch } : {}) } : { ...draft, state: 'sent' })
  } catch {
    chat.approvals.set(box, { state: 'open', problem: 'Could not send it. Is the board still running?', ...(branch ? { pick: branch } : {}) })
  }
  if (chats.has(chat.id)) redrawLive(chat)
}

function redrawLive(chat) {
  chat.liveSignature = ''
  drawLive(chat, context.sessionOf(chat.id))
}

/**
 * The next-step box Claude closed its turn with: its question and the answers it offers. A click
 * sends that answer to the session as a message, as the button in the app does.
 */
function drawNextStep(chat, session, next) {
  const endedAt = session.turn.endedAt
  const given = sentChoices.get(chat.id)
  const sent = given?.endedAt === endedAt ? given : null
  const buttons = next.choices.map((choice, i) => {
    const button = el('button', { type: 'button', class: `next-choice${i === 0 ? ' first' : ''}${sent?.label === choice.label ? ' sent' : ''}`, title: choice.message, disabled: Boolean(sent) }, choice.label)
    button.addEventListener('click', async () => {
      sentChoices.set(chat.id, { endedAt, label: choice.label })
      drawLive(chat, context.sessionOf(chat.id))
      if (!(await sendText(chat.id, choice.message))) sentChoices.set(chat.id, { endedAt: -1, label: '', problem: 'Could not send it. Is the board still running?' })
      chat.signature = ''
      refresh(chat)
    })
    return button
  })
  const note = given?.problem || (sent ? 'Sent. Claude takes it in a moment.' : '')
  return el(
    'div',
    { class: 'next-step in-chat' },
    el('span', { class: 'next-badge' }, 'Your move'),
    next.question ? el('span', { class: 'next-question' }, next.question) : null,
    el('div', { class: 'next-choices' }, buttons),
    note ? el('span', { class: `next-note${given?.problem ? ' problem' : ''}`, role: 'status' }, note) : null,
  )
}

function keepSideAboveCompose(chat) {
  const height = chat.form.offsetHeight
  if (height > 0) chat.root.style.setProperty('--compose-h', `${height}px`)
}

/** A click outside a panel that took the wheel, or Esc, gives the wheel back to the page. */
function releaseSides(keep) {
  for (const chat of chats.values()) if (chat.side !== keep) chat.side.classList.remove('is-scrolling')
}

document.addEventListener('pointerdown', event => releaseSides(event.target.closest?.('.chat-side')), true)
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') releaseSides(null)
})

/** Whether Claude works in the session right now: a session gone quiet or ended has nothing to stop. */
function isWorkingNow(session) {
  if (!session?.turn?.isRunning) return false
  const state = L.sessionState(session, Date.now())
  return state === 'working' || state === 'needs-you'
}

/** Asks the session to stop Claude's running turn; whether the ask is on its way. */
export async function stopTurn(sessionId) {
  try {
    const response = await fetch('/api/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CCC-Action': 'interrupt' },
      body: JSON.stringify({ sessionId }),
    })
    return response.ok
  } catch {
    return false
  }
}

/** The answer last sent from a next-step box, per session: the turn it answered and the button. */
export const sentChoices = new Map()

/** Sends words to the session the way the write box does; whether they are on their way. */
export async function sendText(sessionId, text) {
  try {
    const response = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CCC-Action': 'send' },
      body: JSON.stringify({ sessionId, text, mode: 'queue', images: [] }),
    })
    return response.ok
  } catch {
    return false
  }
}

// ---------- writing ----------

function drawCompose(chat, session) {
  const state = C.composeState(session)
  chat.canSend = state.canSend
  chat.text.disabled = !state.canSend
  chat.send.disabled = !state.canSend || chat.isSending
  chat.queue.disabled = !state.canSend || chat.isSending
  chat.stop.hidden = !(state.canSend && isWorkingNow(session))
  // with a box open, Enter answers it with what is written, as in the app
  if (!chat.problem) chat.note.textContent = state.canSend && openCard(chat) ? CARD_NOTE : state.note
  chat.suggestion = state.canSend ? C.suggestionOf(session) : ''
  showSuggestion(chat)
}

/** Takes a file picked, pasted or dropped: an image Claude sees, or any other file it opens, as in the app. */
function addFile(chat, file) {
  if (!chat.canSend) return
  const isImage = C.isImage(file)
  const problem = isImage ? C.imageProblem(file, chat.images.length) : C.fileProblem(file, chat.files.length)
  if (problem) return say(chat, problem)
  const reader = new FileReader()
  reader.onload = () => {
    if (!chats.has(chat.id)) return
    const data = String(reader.result).split(',', 2)[1] ?? ''
    if (isImage) chat.images.push({ type: file.type, name: file.name, data, url: URL.createObjectURL(file) })
    else chat.files.push({ name: file.name, size: file.size, data })
    drawThumbs(chat)
  }
  reader.onerror = () => say(chat, `Could not read ${file.name || 'that file'}.`)
  reader.readAsDataURL(file)
}

function drawThumbs(chat) {
  chat.thumbs.replaceChildren(
    ...chat.images.map((image, index) => {
      const remove = el('button', { type: 'button', class: 'thumb-remove', 'aria-label': `Remove ${image.name || 'image'}` }, '×')
      remove.addEventListener('click', () => {
        URL.revokeObjectURL(image.url)
        chat.images.splice(index, 1)
        drawThumbs(chat)
      })
      return el('figure', { class: 'thumb' }, el('img', { src: image.url, alt: image.name || 'Image to send' }), remove)
    }),
    ...chat.files.map((file, index) => {
      const remove = el('button', { type: 'button', class: 'thumb-remove', 'aria-label': `Remove ${file.name || 'file'}` }, '×')
      remove.addEventListener('click', () => {
        chat.files.splice(index, 1)
        drawThumbs(chat)
      })
      return el('figure', { class: 'thumb thumb-file', title: file.name }, icon('M9 1.5H4a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V6L9 1.5zM9 1.5V6h4.5', 16), el('span', { class: 'thumb-name' }, file.name || 'file'), el('span', { class: 'thumb-size' }, C.fileSize(file.size)), remove)
    }),
  )
}

function say(chat, problem) {
  chat.problem = problem
  chat.note.textContent = problem
  setTimeout(() => {
    if (chat.problem !== problem) return
    chat.problem = ''
    drawCompose(chat, context.sessionOf(chat.id))
  }, 4000)
}

const CARD_NOTE = 'A box waits for you: Enter or Send answers it with what you write, as in the app. ⌘Enter stops Claude and sends it instead.'

/**
 * The box Claude waits on that can be answered from here, if any: an approval (the branch question
 * among them) or a question. While one is open, what the person writes answers it, as in the app.
 */
function openCard(chat) {
  const session = context.sessionOf(chat.id)
  if (!session?.turn?.isRunning) return null
  const approval = C.approvalView(L.waitingFor(session))
  if (approval?.canAnswer) return { kind: 'approval', box: approval.box }
  const question = [...chat.items].reverse().find(item => item.kind === 'question')
  if (question && !question.answers && !question.isDeclined && question.toolId && C.ANSWERS_FROM_CCC.has(session.entrypoint)) return { kind: 'question', toolId: question.toolId }
  return null
}

/**
 * Sends what is written: `now` stops Claude first if it works, `queue` waits until it is done. With
 * a box open, a message of words alone (`queue`, the usual Enter) answers the box instead: the app
 * turns the call down and hands Claude the words, and Claude goes on with them in the same turn.
 */
async function sendMessage(chat, mode) {
  if (!chat.canSend || chat.isSending) return
  // an emoticon typed last, with no space after it, turns into its emoji as it is sent
  const typed = chat.text.value.trim()
  const text = C.emojifyAt(typed, typed.length)?.text ?? typed
  if (!text && chat.images.length === 0 && chat.files.length === 0) return
  const tooLong = C.lengthProblem(text)
  if (tooLong) return say(chat, tooLong)
  chat.isSending = true
  chat.send.disabled = true
  chat.queue.disabled = true
  const card = mode === 'queue' && text && chat.images.length === 0 && chat.files.length === 0 ? openCard(chat) : null
  const request = !card
    ? { route: '/api/send', action: 'send', body: { sessionId: chat.id, text, mode, images: chat.images.map(image => ({ mediaType: image.type, name: image.name, data: image.data })), files: chat.files.map(file => ({ name: file.name, data: file.data })) } }
    : card.kind === 'approval'
      ? { route: '/api/approve', action: 'approve', body: { sessionId: chat.id, box: card.box, decision: 'deny', message: text } }
      : { route: '/api/answer', action: 'answer', body: { sessionId: chat.id, toolId: card.toolId, message: text } }
  try {
    const response = await fetch(request.route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CCC-Action': request.action },
      body: JSON.stringify(request.body),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    // the server says what was wrong with a message it did not take: the words stay to be fixed
    const answer = await response.json().catch(() => ({ ok: true }))
    if (answer.ok === false || answer.problem) return say(chat, answer.problem || 'The message was not taken.')
    if (card?.kind === 'approval') chat.approvals.set(card.box, { state: 'sent', choice: 'deny', said: true })
    // a session that has stopped wakes when its chat is opened where it lives
    const session = context.sessionOf(chat.id)
    const wakeIn = C.composeState(session).wakeIn
    const link = wakeIn ? L.openLink(session) : null
    if (link) {
      el('a', { href: link.href }).click()
      setTimeout(() => say(chat, `Waking the session in ${wakeIn}: your message goes in as soon as it runs.`), 0)
    }
    for (const image of chat.images) URL.revokeObjectURL(image.url)
    chat.images = []
    chat.files = []
    // the suggestion was for this prompt: it does not come back in the emptied box
    chat.suggestion = ''
    chat.text.value = ''
    saveDraft(chat)
    grow(chat.text)
    drawThumbs(chat)
    chat.isFollowing = true
    chat.signature = ''
    refresh(chat)
  } catch {
    say(chat, 'Could not send it. Is the board still running?')
  } finally {
    chat.isSending = false
    drawCompose(chat, context.sessionOf(chat.id))
  }
}

// ---------- Claude's text ----------

function markdown(text) {
  return el('div', { class: 'md' }, blocks(text).map(drawBlock))
}

function drawBlock(block) {
  switch (block.type) {
    case 'heading':
      return el(block.level <= 2 ? 'h3' : 'h4', {}, spans(block.inline))
    case 'list':
      return el(block.ordered ? 'ol' : 'ul', block.ordered && block.start > 1 ? { start: block.start } : {}, block.items.map(item => el('li', {}, spans(item))))
    case 'table':
      return el('div', { class: 'md-table' }, el('table', {}, el('thead', {}, el('tr', {}, block.head.map(cell => el('th', {}, spans(cell))))), el('tbody', {}, block.rows.map(row => el('tr', {}, row.map(cell => el('td', {}, spans(cell))))))))
    case 'quote':
      return el('blockquote', {}, block.blocks.map(drawBlock))
    case 'code':
      return codeBlock(block)
    case 'rule':
      return el('hr')
    default:
      return el('p', {}, spans(block.inline))
  }
}

/** A code block with its language and a button that copies it whole, as an editor's chat has. */
function codeBlock(block) {
  const copy = el('button', { type: 'button', class: 'code-copy', title: 'Copy to the clipboard' }, icon('M5.5 5.5h7v8h-7zM3.5 10.5v-8h7', 12), el('span', {}, 'Copy'))
  copy.addEventListener('click', async () => {
    const isCopied = await copyText(block.text)
    copy.lastChild.textContent = isCopied ? 'Copied' : 'Select and copy'
    copy.classList.toggle('done', isCopied)
    setTimeout(() => {
      copy.lastChild.textContent = 'Copy'
      copy.classList.remove('done')
    }, 1600)
  })
  return el('div', { class: 'md-code' }, el('div', { class: 'md-code-bar' }, el('span', { class: 'md-code-lang' }, block.lang || 'text'), copy), el('pre', {}, el('code', {}, block.text)))
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // an older page or a blocked clipboard: copy through a hidden box instead
    const box = el('textarea', { style: 'position:fixed;opacity:0;top:0;left:0' })
    box.value = text
    document.body.append(box)
    box.select()
    const isCopied = document.execCommand?.('copy') ?? false
    box.remove()
    return isCopied
  }
}

// flat, since plain text with line breaks is several pieces (text, a <br>, text); a list inside the
// list would be written out as words, as "[object HTMLBRElement]"
function spans(list) {
  return list.flatMap(span => {
    if (span.t === 'strong') return el('strong', {}, lines(span.text))
    if (span.t === 'em') return el('em', {}, lines(span.text))
    if (span.t === 'code') return el('code', {}, span.text)
    if (span.t === 'link') return el('a', { href: span.href, target: '_blank', rel: 'noopener noreferrer' }, span.text)
    return lines(span.text)
  })
}

function lines(text) {
  return String(text)
    .split('\n')
    .flatMap((part, i) => (i === 0 ? [part] : [el('br'), part]))
}
