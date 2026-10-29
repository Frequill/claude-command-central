// Terminal cards: a real shell on the board, drawn by xterm.js (the terminal VS Code uses).
//
// CCC's keeper runs each shell, so it goes on when the board's server stops; the server passes
// everything on. One long request brings what every shell prints, and each key press goes back in a
// small POST, in order. Every request carries the key the server made when it started, which only
// this page can read. A terminal can also run a Claude session started in the background: its card
// is only on the board while the person wants to see it.

import * as L from './board-logic.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const RETRY_MS = [500, 1000, 2000, 4000]
const RESIZE_WAIT_MS = 80
const SCROLLBACK = 5000
// how many lines up from the newest one each terminal was scrolled, kept for this tab, so a reload
// or a fresh copy of the output from the server lands where the person was reading
const SCROLL_KEY = 'ccc.terminalScroll'

const terminals = new Map()
const linesUp = readLinesUp()
let context = { appName: () => 'Terminal', appId: () => 'auto', themeId: () => 'aero', isOnBoard: () => false, onClose: () => {}, onHide: () => {}, onRestarted: () => {} }
let key = ''
let isStreaming = false

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

/** What the board tells the terminals: its terminal app, its theme, and what to do on close. */
export function setupTerminals(given) {
  context = { ...context, ...given }
  if (!isStreaming) {
    isStreaming = true
    // the newest place of each, as output may have come in since the person last scrolled
    window.addEventListener('pagehide', () => {
      for (const term of terminals.values()) noteScroll(term)
    })
    stream()
  }
}

function readLinesUp() {
  try {
    const kept = JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? '{}')
    return new Map(Object.entries(kept).filter(([, up]) => Number.isInteger(up) && up > 0))
  } catch {
    return new Map()
  }
}

function saveLinesUp() {
  try {
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify(Object.fromEntries(linesUp)))
  } catch {
    // no storage here: the place is kept for as long as the page is open
  }
}

/** Remembers how far up the person has scrolled in a terminal: 0 is at the newest line. */
function noteScroll(term) {
  if (!term.isFilled || term.isRestoring) return
  const buffer = term.xterm.buffer.active
  const up = Math.max(0, buffer.baseY - buffer.viewportY)
  if ((linesUp.get(term.id) ?? 0) === up) return
  if (up > 0) linesUp.set(term.id, up)
  else linesUp.delete(term.id)
  saveLinesUp()
}

/** Scrolls a terminal back to where the person was reading. */
function restoreScroll(term) {
  const up = linesUp.get(term.id) ?? 0
  if (up > 0) term.xterm.scrollToLine(Math.max(0, term.xterm.buffer.active.baseY - up))
  else term.xterm.scrollToBottom()
}

/** The key every terminal request carries; asked for again after the server restarts. */
async function terminalKey(isFresh = false) {
  if (key && !isFresh) return key
  const response = await fetch('/api/terminals/key', { cache: 'no-store' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  key = (await response.json()).key ?? ''
  return key
}

async function ask(route, action, body) {
  const send = async isFresh =>
    fetch(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CCC-Action': action, 'X-CCC-Key': await terminalKey(isFresh) },
      body: JSON.stringify(body),
    })
  let response = await send(false)
  if (response.status === 403) response = await send(true)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** Starts a shell in the folder: { id } or { problem }. */
export async function startTerminal(folder) {
  try {
    const data = await ask('/api/terminal/start', 'terminal-start', { folder, cols: 100, rows: 30 })
    return data.ok ? { id: data.id } : { problem: data.problem || 'Could not start the terminal.' }
  } catch {
    return { problem: 'Could not start the terminal. Is the board still running?' }
  }
}

/** Puts a background session's terminal on the board, or takes it off it; Claude runs on either way. */
export async function toggleTerminal(id, isHidden) {
  try {
    return (await ask('/api/terminal/show', 'terminal-show', { id, hidden: isHidden })).ok === true
  } catch {
    return false
  }
}

/** Ends CCC's keeper and everything that runs in it; whether it went. */
export async function stopKeeper() {
  try {
    return (await ask('/api/keeper/stop', 'terminal-keeper-stop', {})).ok === true
  } catch {
    return false
  }
}

/** Reads what every shell prints, for as long as the page is open; it reconnects after a break. */
async function stream() {
  let tries = 0
  for (;;) {
    try {
      let response = await fetch('/api/terminals/stream', { cache: 'no-store', headers: { 'X-CCC-Key': await terminalKey() } })
      if (response.status === 403) response = await fetch('/api/terminals/stream', { cache: 'no-store', headers: { 'X-CCC-Key': await terminalKey(true) } })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      tries = 0
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let rest = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        rest += decoder.decode(value, { stream: true })
        const lines = rest.split('\n')
        rest = lines.pop()
        for (const line of lines) if (line) take(JSON.parse(line))
      }
    } catch {
      // the server went away for a moment, or the page lost it: try again soon
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)]))
  }
}

function bytesOf(base64) {
  const text = atob(base64)
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}

// what came for a terminal whose card is not made yet waits for it
const early = new Map()

function take(piece) {
  if (piece.beat) return
  const term = terminals.get(piece.id)
  if (!term) {
    if (piece.reset) early.set(piece.id, [piece])
    else if (early.has(piece.id)) early.get(piece.id).push(piece)
    return
  }
  apply(term, piece)
}

function apply(term, piece) {
  if (piece.reset) {
    // the whole output again (a reload, or the stream came back): once it is written, the screen
    // goes back to where the person was reading, not to the top
    noteScroll(term)
    term.xterm.reset()
    term.ended = null
    term.isRestoring = true
    term.xterm.write(piece.data ? bytesOf(piece.data) : '', () => {
      term.isRestoring = false
      term.isFilled = true
      restoreScroll(term)
    })
  } else if (piece.data) term.xterm.write(bytesOf(piece.data))
  if (piece.ended) {
    term.ended = { exitCode: piece.exitCode }
    drawEnded(term)
    drawHead(term)
  }
}

/** The terminal's card, made once and kept, so what the shell shows stays while the board redraws. */
export function terminalCard(card) {
  const known = terminals.get(card.id)
  if (known) return known.root
  const term = buildCard(card)
  terminals.set(card.id, term)
  for (const piece of early.get(card.id) ?? []) apply(term, piece)
  early.delete(card.id)
  if (card.endedAt) {
    term.ended = { exitCode: card.exitCode }
    drawEnded(term)
  }
  drawHead(term)
  return term.root
}

function buildCard(card) {
  const head = el('header', { class: 'chat-head terminal-head' })
  const screen = el('div', { class: 'terminal-screen' })
  const endBar = el('div', { class: 'terminal-ended', role: 'status', hidden: true })
  const body = el('div', { class: 'terminal-body' }, screen, endBar)
  const root = el(
    'article',
    { class: `glass tile expanded-tile terminal-tile terminal-${context.themeId()}`, 'data-session': card.id, 'data-ghost': 'light', 'aria-label': `Terminal: ${L.folderLabel(card.folder).name}` },
    head,
    body,
    el('span', { class: 'grip grip-x', 'data-axis': 'x', 'aria-hidden': 'true' }),
    el('span', { class: 'grip grip-y', 'data-axis': 'y', 'aria-hidden': 'true' }),
    el('span', { class: 'grip', 'aria-hidden': 'true' }),
    el('span', { class: 'grip grip-bl', 'data-axis': 'corner-bl', 'aria-hidden': 'true' }),
    el('span', { class: 'grip grip-tr', 'data-axis': 'corner-tr', 'aria-hidden': 'true' }),
    el('span', { class: 'grip grip-tl', 'data-axis': 'corner-tl', 'aria-hidden': 'true' }),
  )
  const look = L.terminalLook(context.themeId())
  const xterm = new window.Terminal({
    allowProposedApi: false,
    cursorBlink: true,
    fontFamily: look.fontFamily,
    fontSize: look.fontSize,
    lineHeight: look.lineHeight,
    scrollback: SCROLLBACK,
    macOptionIsMeta: true,
    theme: look.theme,
  })
  const fit = new window.FitAddon.FitAddon()
  xterm.loadAddon(fit)
  const term = { id: card.id, card, root, head, screen, endBar, xterm, fit, title: '', ended: null, sending: Promise.resolve(), resizeTimer: 0, isOpen: false, isFilled: false, isRestoring: false, themeClass: `terminal-${context.themeId()}` }

  xterm.onData(data => typeInto(term, data))
  xterm.onBinary(data => typeInto(term, data))
  xterm.onScroll(() => noteScroll(term))
  xterm.onTitleChange(title => {
    term.title = title
    // kept while a command runs and the title names the command instead
    term.titleWhere = L.titleFolder(title, term.card.where || term.card.folder) ?? term.titleWhere
    drawHead(term)
  })
  xterm.onResize(({ cols, rows }) => {
    clearTimeout(term.resizeTimer)
    term.resizeTimer = setTimeout(() => {
      if (!term.ended) ask('/api/terminal/resize', 'terminal-resize', { id: term.id, cols, rows }).catch(() => {})
    }, RESIZE_WAIT_MS)
  })
  // the shell opens once the card has a size on the board, and follows it as it is pulled bigger
  new ResizeObserver(() => fitScreen(term)).observe(screen)
  // the board moves a card by its header: a click in the screen is for the shell
  screen.addEventListener('pointerdown', () => xterm.focus())
  measureWhenLoaded(term, look)
  return term
}

/**
 * xterm.js measures its letters when it gets a font. A web font still loading is measured as the
 * fallback, and the lines then run past the card's edge, so it measures again once the font is here.
 */
function measureWhenLoaded(term, look) {
  const family = look.fontFamily.split(',')[0].trim()
  document.fonts?.load(`${look.fontSize}px ${family}`).then(() => {
    if (!terminals.has(term.id) || term.xterm.options.fontFamily !== look.fontFamily) return
    term.xterm.options.fontFamily = 'monospace'
    term.xterm.options.fontFamily = look.fontFamily
    fitScreen(term)
  }, () => {})
}

function fitScreen(term) {
  if (!term.screen.isConnected || term.screen.clientWidth < 20 || term.screen.clientHeight < 20) return
  const isFirst = !term.isOpen
  if (isFirst) {
    term.isOpen = true
    term.xterm.open(term.screen)
    // xterm.js tells of a scroll by the wheel or the scroll bar only through its own scroll box
    term.screen.querySelector('.xterm-viewport')?.addEventListener('scroll', () => noteScroll(term), { passive: true })
  }
  try {
    term.fit.fit()
  } catch {
    // not laid out yet; the next resize fits it
  }
  // output written before the card had a size: its place is set again now that it is drawn
  if (isFirst && term.isFilled) restoreScroll(term)
}

/** Key presses go to the shell one after another, never overtaking each other. */
function typeInto(term, data) {
  if (term.ended) return
  term.sending = term.sending.then(() => ask('/api/terminal/type', 'terminal-type', { id: term.id, data }).catch(() => {}))
}

function drawHead(term) {
  // where the shell is now: what its title says at the prompt, at once, else the server's look a
  // moment after it (for shells that set no title)
  const where = term.titleWhere ?? (term.card.where || term.card.folder)
  const label = L.folderLabel(where)
  const title = L.terminalTitle(term.title, where)
  const appName = context.appName()
  const isClaude = term.card.kind === 'claude'
  // hidden, it is brought back from its session's card: until that card is on the board (Claude
  // asks something before it starts), the × closes it like any terminal
  const isHiding = isClaude && !term.ended && context.isOnBoard(term.card.sessionId)
  const signature = JSON.stringify([title, appName, Boolean(term.ended), where, isClaude, isHiding])
  if (signature === term.headSignature) return
  term.headSignature = signature
  // Claude in the background has no folder of its own to open elsewhere: its session's card is the way in
  const open = isClaude ? null : el('button', { type: 'button', class: 'open-link terminal-open', title: `Opens a new ${appName} window in the folder this shell is in now` }, `Open in ${appName}`, icon('M9 2h5v5M14 2 7 9', 11))
  open?.addEventListener('click', () => openInApp(term, open))
  const close = el(
    'button',
    {
      type: 'button',
      class: 'chat-close chat-remove',
      'aria-label': isHiding ? `Hide ${title}` : `Close ${title}`,
      title: isHiding ? 'Hide: Claude keeps working in the background. Its card can show this again.' : term.ended ? 'Close this terminal' : 'Close: ends the shell and what runs in it',
    },
    icon('M4 4l8 8M12 4l-8 8'),
  )
  close.addEventListener('click', () => (isHiding ? context.onHide(term.id) : context.onClose(term.id, title, Boolean(term.ended))))
  term.head.replaceChildren(
    el('span', { class: 'terminal-glyph', 'aria-hidden': 'true' }, '>_'),
    el('span', { class: 'chat-title' }, title),
    el('span', { class: 'source source-terminal' }, isClaude ? 'Claude in the background' : 'Terminal'),
    el('span', { class: 'chat-where', title: where }, `${label.parent}/${label.name}`.replace('//', '/')),
    el('span', { class: `pill ${term.ended ? 'pill-done' : 'pill-work'}` }, term.ended ? 'ended' : 'running'),
    ...[open, close].filter(Boolean),
  )
  term.root.setAttribute('aria-label', `Terminal: ${title}`)
}

function drawEnded(term) {
  const code = term.ended?.exitCode
  const isClaude = term.card.kind === 'claude'
  // a shell is started again in its folder; Claude ended, its conversation is picked up from + instead
  const again = isClaude ? null : el('button', { type: 'button', class: 'primary' }, 'Start again')
  again?.addEventListener('click', () => restart(term, again))
  const close = el('button', { type: 'button', class: 'secondary' }, 'Close')
  close.addEventListener('click', () => context.onClose(term.id, L.terminalTitle(term.title, term.card.where || term.card.folder), true))
  const what = isClaude ? 'Claude' : 'The shell'
  term.endBar.replaceChildren(el('span', {}, Number.isInteger(code) && code !== 0 ? `${what} ended (exit ${code}).` : `${what} ended.`), ...[again, close].filter(Boolean))
  term.endBar.hidden = false
}

async function restart(term, button) {
  button.disabled = true
  const started = await startTerminal(term.card.folder)
  if (started.problem) {
    button.disabled = false
    term.endBar.firstChild.textContent = started.problem
    return
  }
  await ask('/api/terminal/close', 'terminal-close', { id: term.id }).catch(() => {})
  context.onRestarted(term.id, started.id)
}

async function openInApp(term, button) {
  button.disabled = true
  try {
    const data = await ask('/api/terminal/open', 'terminal-open', { id: term.id, app: context.appId() })
    if (!data.ok) term.xterm.writeln(`\r\n\x1b[31m${data.problem || 'Could not open the terminal app.'}\x1b[0m`)
  } catch {
    term.xterm.writeln('\r\n\x1b[31mCould not open the terminal app. Is the board still running?\x1b[0m')
  } finally {
    button.disabled = false
  }
}

/** Ends the shell (when it still runs) and lets the card go. */
export async function closeTerminal(id) {
  try {
    await ask('/api/terminal/close', 'terminal-close', { id })
    return true
  } catch {
    return false
  }
}

/** Called on every board update: each card's header follows the server's word on its shell. */
export function updateTerminal(card) {
  const term = terminals.get(card.id)
  if (!term) return
  term.card = card
  if (card.endedAt && !term.ended) {
    term.ended = { exitCode: card.exitCode }
    drawEnded(term)
  }
  drawHead(term)
}

/** Forgets a card that left the board. */
export function dropTerminal(id) {
  const term = terminals.get(id)
  if (!term) return
  term.xterm.dispose()
  terminals.delete(id)
  if (linesUp.delete(id)) saveLinesUp()
}

export function focusTerminal(id) {
  terminals.get(id)?.xterm.focus()
}

/** Every terminal takes the colours and font of the theme the board shows. */
export function themeTerminals(themeId) {
  const look = L.terminalLook(themeId)
  for (const term of terminals.values()) {
    term.root.classList.remove(term.themeClass)
    term.themeClass = `terminal-${themeId}`
    term.root.classList.add(term.themeClass)
    term.xterm.options.theme = look.theme
    term.xterm.options.fontFamily = look.fontFamily
    term.xterm.options.fontSize = look.fontSize
    term.xterm.options.lineHeight = look.lineHeight
    term.headSignature = ''
    drawHead(term)
    fitScreen(term)
    measureWhenLoaded(term, look)
  }
}

export function isTerminal(id) {
  return terminals.has(id)
}
