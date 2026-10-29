import * as L from './board-logic.js'
import { startDecor } from './decor.js'
import { welcome } from './arrivals.js'
import { chatCard, dropChat, focusChat, redrawChats, sendText, sentChoices, setupChat, updateChat } from './chat.js'
import { cavemanOf } from './chat-logic.js'
import { carryAway } from './dragon.js'
import { jelly, loadLayout, makeResizable, makeSortable, saveLayout, watchWindowMoves } from './layout.js'
import { setupNotes } from './notes.js'
import { loadSettings, setupSettings } from './settings.js'
import { startScene } from './themes.js'
import { makeGrid } from './grid.js'
import { closeTerminal, dropTerminal, focusTerminal, isTerminal, setupTerminals, startTerminal, terminalCard, themeTerminals, updateTerminal } from './terminal.js'

const POLL_MS = 1000
const TOKENS_POLL_MS = 15_000
const TOKEN_CHART = { width: 240, height: 48 }
const WARN_PERCENT = 80
const BUBBLES = 22
const SVG_NS = 'http://www.w3.org/2000/svg'
const LIMIT_KINDS = ['five_hour', 'seven_day']
const SIDEBAR_ORDER = ['tools', 'notes']
const CHAT_SHOWN = 3
const LIVE_LINES = { compact: 3, large: 8 }
const REPLY_LINES = 7
const PLAN_MARK = { completed: '✓', in_progress: '', pending: '' }
const REPLY_NOTES = {
  thinking: 'Claude is working on it…',
  empty: 'Nothing written yet.',
}
const RUN_MARK = { running: '●', done: '✓', failed: '✗', started: '◌', proposed: '◌' }
const LOG_MARK = { running: '…', ok: '✓', error: '✗' }
const MAP = { rowH: 72, agentH: 62, sessionH: 50, groupGap: 20, edgeW: 120 }
const SMALL_RING = { size: 52, radius: 20, width: 7 }

const view = {
  tiles: new Map(),
  // when the person last pressed a key on the board
  typedAt: 0,
  map: '',
  tools: '',
  slots: new Map(),
  firstSeen: new Map(),
  openLogs: new Set(),
  newestLog: new Map(),
  layout: loadLayout(),
  settings: loadSettings(),
  wobble: false,
  stopScene: () => {},
  isInteracting: false,
  limitPeaks: new Map(),
  removing: new Set(),
  /** The order of the cards on the board (the grid in grid.js places them), and the grid itself. */
  order: [],
  grid: null,
  hidden: [],
  follow: new Map(),
  onBoard: null,
  byId: new Map(),
  tags: new Map(),
  expanded: new Set(),
  last: null,
  decor: { update() {}, stop() {} },
  /** The terminals the board's server runs, and the terminal apps this Mac has. */
  terminals: [],
  terminalApps: [],
  /** The editors this Mac has, that a step's file can open in. */
  editorApps: [],
  /** Caveman mode as the server keeps it: the default, and each session's own choice. */
  caveman: { default: 'off', sessions: {} },
}

// ---------- small DOM helpers: every text goes in as textContent ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (name === 'class') node.className = value
    else if (name === 'style') node.style.cssText = value
    else node.setAttribute(name, value === true ? '' : String(value))
  }
  append(node, children)
  return node
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) node.setAttribute(name, String(value))
  }
  if (text !== undefined) node.textContent = text
  return node
}

function append(node, children) {
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

/** A text that counts up from `start` (or stays at `end`) each second. */
function since(start, end, attrs = {}) {
  return el('span', { ...attrs, 'data-since': start, 'data-until': end })
}

function setText(selector, value) {
  const node = document.querySelector(selector)
  if (node && node.textContent !== String(value)) node.textContent = String(value)
}

function clip(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** A glossy ring gauge: track, arc, a highlight and the value in the middle. */
function ring({ size, radius, width, percent, stroke, label, alt, className }) {
  const middle = size / 2
  const box = svg('svg', { class: className, width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': alt })
  box.append(svg('circle', { class: 'ring-track', cx: middle, cy: middle, r: radius, 'stroke-width': width }))
  box.append(
    svg('circle', {
      class: 'ring-arc',
      cx: middle,
      cy: middle,
      r: radius,
      stroke,
      'stroke-width': width,
      'stroke-linecap': 'round',
      'stroke-dasharray': L.ringDash(percent, radius),
    }),
  )
  box.append(svg('ellipse', { class: 'ring-gloss', cx: middle, cy: middle - radius * 0.44, rx: radius * 0.6, ry: radius * 0.24 }))
  box.append(svg('text', { class: 'ring-text', x: middle, y: middle + size * 0.07, 'font-size': Math.round(size * 0.2) }, label))
  return box
}

// ---------- settings, background and scaling ----------

function applySettings(settings) {
  const isNewLook = view.settings.theme !== settings.theme || view.settings.cardSize !== settings.cardSize
  const isNewNotes = view.settings.showNotes !== settings.showNotes
  view.settings = settings
  if (isNewNotes) redrawChats()
  for (const name of [...document.body.classList]) if (name.startsWith('theme-')) document.body.classList.remove(name)
  document.body.classList.add(`theme-${settings.theme}`)
  document.body.classList.toggle('motion-off', !settings.animations)
  // the agent map draws its moving dots only while things move
  view.map = ''
  view.wobble = L.wobbles(settings)
  document.body.classList.toggle('cards-large', settings.cardSize === 'large')
  // without the right column the cards get the whole width; they are placed again in it
  const isSideNew = document.body.classList.contains('side-off') === settings.sidePanel
  document.body.classList.toggle('side-off', !settings.sidePanel)
  document.body.classList.toggle('shift-scroll', settings.shiftScroll)
  if (isSideNew) applyScale()
  view.stopScene()
  view.stopScene = startScene(document.querySelector('#scene-canvas'), settings.theme, { animated: settings.animations, freezeAway: settings.freeze })
  view.decor.stop()
  view.decor = startDecor(settings.theme, { statusBar: settings.statusBar })
  view.grid?.animate(settings.animations)
  followFocus()
  themeTerminals(settings.theme)
  if (isNewLook) redrawTiles()
}

/**
 * With "Freeze in background" on, nothing on the board moves while its window is not the one in
 * use, so it costs next to nothing on a screen beside the work; the numbers and cards still change.
 * It moves again on coming back. With it off, the board keeps moving all the time.
 */
function followFocus() {
  const isAway = Boolean(view.settings.freeze) && !document.hasFocus()
  document.body.classList.toggle('away', isAway)
  for (const picture of document.querySelectorAll('svg')) {
    if (isAway) picture.pauseAnimations?.()
    else picture.unpauseAnimations?.()
  }
}

window.addEventListener('focus', followFocus)
window.addEventListener('blur', followFocus)

function redrawTiles() {
  for (const tile of view.tiles.values()) tile.node.remove()
  view.tiles.clear()
  view.map = ''
}

/** Shrinks the whole board with the window, down to a size that stays readable. */
function applyScale() {
  document.documentElement.style.setProperty('--ui-scale', L.scaleFor(window.innerWidth).toFixed(3))
  view.map = ''
}

function makeBubbles() {
  const box = document.querySelector('#bubbles')
  for (let i = 0; i < BUBBLES; i += 1) {
    const size = 14 + ((i * 53) % 70)
    box.append(
      el('span', {
        class: 'bubble',
        style: [
          `left:${(i * 37 + ((i * 7919) % 97)) % 100}%`,
          `width:${size}px`,
          `height:${size}px`,
          `animation-duration:${14 + ((i * 29) % 16)}s,${3 + ((i * 11) % 4)}s`,
          `animation-delay:${-((i * 13) % 24)}s,0s`,
          `opacity:${(0.55 + ((i * 17) % 40) / 100).toFixed(2)}`,
        ].join(';'),
      }),
    )
  }
}

/** A small bubble (or ember, or spark) that floats up out of a card when its log moves. */
function popBubble(host) {
  if (!view.settings.animations) return
  const size = 8 + Math.round(Math.random() * 12)
  const bubble = el('span', { class: 'pop-bubble', style: `left:${10 + Math.random() * 80}%;width:${size}px;height:${size}px` })
  bubble.addEventListener('animationend', () => bubble.remove())
  host.append(bubble)
}

// ---------- layout: dragging and resizing ----------

function setupLayout() {
  const tiles = document.querySelector('#sessions')
  const startInteracting = () => {
    view.isInteracting = true
  }

  // the cards sit in a grid that moves them out of each other's way (grid.js)
  view.grid = makeGrid(tiles, {
    onStart: startInteracting,
    onEnd: () => {
      view.isInteracting = false
      updateChat()
    },
    // a card's place on the old free board, so the grid starts out looking like it
    oldPlace: id => {
      const card = view.layout.cards[id]
      if (!card || !Number.isFinite(card.x)) return null
      const chat = L.chatBox(view.layout.chats?.[id])
      return { x: card.x, y: card.y, w: chat.w, h: chat.h }
    },
    wobbles: () => view.wobble,
    animates: () => view.settings.animations,
  })
  setupPanels()
}

/** The panels at the right and above: sorted by their titles, and sized by their grips. */
function setupPanels() {
  const sidebar = document.querySelector('#sidebar')
  makeSortable(sidebar, {
    items: '.panel',
    handle: '.window-title',
    idOf: node => node.dataset.panel,
    onDrop: ids => {
      view.layout.panelOrder = ids
      saveLayout(view.layout)
    },
    wobbles: () => view.wobble,
  })
  const resizePanel = (node, size, isDone) => {
    const panel = { minHeight: Math.max(120, Math.round(size.height)) }
    sizePanel(node, panel)
    if (node.parentElement === sidebar) setSidebarWidth(size.width)
    if (!isDone) return
    view.layout.panels[node.dataset.panel] = panel
    if (node.parentElement === sidebar) view.layout.sidebarWidth = Math.round(Math.min(900, Math.max(260, size.width)))
    saveLayout(view.layout)
    view.map = ''
  }
  makeResizable(sidebar, { items: '.panel', onResize: resizePanel, wobbles: () => view.wobble })
  makeResizable(document.querySelector('.main-column'), { items: '.map-panel', onResize: resizePanel, wobbles: () => view.wobble })

  for (const panel of document.querySelectorAll('.panel')) {
    // the panels at the right take their left edge for width; every panel its bottom edge for height
    if (panel.parentElement === sidebar) panel.append(el('span', { class: 'grip grip-left', 'data-axis': 'left', 'aria-hidden': 'true' }))
    panel.append(el('span', { class: 'grip grip-y', 'data-axis': 'y', 'aria-hidden': 'true' }))
    panel.append(el('span', { class: 'grip', 'aria-hidden': 'true' }))
    sizePanel(panel, view.layout.panels[panel.dataset.panel])
  }
  setSidebarWidth(view.layout.sidebarWidth)
  orderPanels()
}

function setSidebarWidth(width) {
  const workspace = document.querySelector('.workspace')
  if (width) workspace.style.setProperty('--sidebar-width', `${Math.round(Math.min(900, Math.max(260, width)))}px`)
  else workspace.style.removeProperty('--sidebar-width')
}

function sizePanel(node, panel) {
  node.style.minHeight = panel?.minHeight ? `${panel.minHeight}px` : ''
}

function orderPanels() {
  const sidebar = document.querySelector('#sidebar')
  const order = [...view.layout.panelOrder.filter(id => SIDEBAR_ORDER.includes(id)), ...SIDEBAR_ORDER.filter(id => !view.layout.panelOrder.includes(id))]
  for (const id of order) {
    const panel = sidebar.querySelector(`[data-panel="${id}"]`)
    if (panel) sidebar.append(panel)
  }
}

function resetLayout() {
  view.grid?.reset(view.order)
  view.layout = L.normalizeLayout(null)
  saveLayout(view.layout)
  redrawTiles()
  for (const panel of document.querySelectorAll('.panel')) sizePanel(panel, undefined)
  setSidebarWidth(undefined)
  orderPanels()
}

/** Opens a card where it is into its session's chat; the other cards move aside. */
function expandCard(sessionId) {
  view.expanded.add(sessionId)
  rerender()
  focusChat(sessionId)
  const node = view.tiles.get(sessionId)?.node
  if (node && view.wobble) jelly(node)
}

function rerender() {
  if (view.last) render(view.last, Date.now())
}

/** A card's own fold and size, from its fold button and its corner grip. */
function setCard(sessionId, change) {
  const card = { ...view.layout.cards[sessionId] }
  const next = { ...card, ...change(card) }
  if (!next.collapsed) delete next.collapsed
  delete next.expanded
  view.layout.cards[sessionId] = next
  saveLayout(view.layout)
  const tile = view.tiles.get(sessionId)
  if (tile) tile.signature = ''
  view.isInteracting = false
}

// ---------- overview ----------

function renderOverview(summary, limits, now) {
  const parts = [
    { id: '#ring-working', value: summary.working },
    { id: '#ring-needs', value: summary.needsYou },
    { id: '#ring-done', value: summary.done },
  ]
  const segments = L.donutSegments(parts, 40, 3)
  for (const part of parts) setArc(part.id, part.value > 0 ? segments.find(segment => segment.id === part.id) : undefined)
  setText('#ring-live', summary.live)
  const told = `${summary.live} active sessions: ${summary.working} working, ${summary.needsYou} need you, ${summary.done} done, ${summary.agentsRunning} agents running`
  document.querySelector('#sessions-ring').setAttribute('aria-label', told)
  document.querySelector('.sum-sessions')?.setAttribute('title', told)
  setText('#stat-working', `${summary.working} working`)
  setText('#stat-needs', `${summary.needsYou} need${summary.needsYou === 1 ? 's' : ''} you`)
  setText('#stat-done', `${summary.done} done`)
  setText('#stat-agents', `${summary.agentsRunning} agent${summary.agentsRunning === 1 ? '' : 's'} running`)

  renderLimits(limits, now)
}

// ---------- tokens today, in the header ----------

/** Today's tokens across every session, read from the transcripts by the server. */
async function pollTokens() {
  try {
    const response = await fetch('/api/tokens', { cache: 'no-store' })
    if (!response.ok) return
    const data = await response.json()
    if (!data?.today || !data?.yesterday) return
    view.tokens = data
    renderTokens(Date.now())
    renderPromptCount(view.tags)
  } catch {
    // the last numbers stay until the server answers again
  }
}

function renderTokens(now) {
  const data = view.tokens
  if (!data) return
  const { today, yesterday } = data
  setText('#tokens-total', L.tokens(today.total))
  setText('#tokens-output', L.tokens(today.output))
  setText('#tokens-input', L.tokens(today.input))
  setText('#tokens-cached', L.tokens(today.cached))
  setText('#tokens-yesterday', L.tokens(yesterday.total))
  document
    .querySelector('#tokens-yesterday-box')
    .setAttribute('title', `Yesterday: ${L.tokens(yesterday.total)} tokens in all, ${L.tokens(yesterday.output)} output, ${L.tokens(yesterday.input)} input and ${L.tokens(yesterday.cached)} cached.`)
  const paths = L.tokenPaths(data.hours?.today, now, TOKEN_CHART.width, TOKEN_CHART.height)
  document.querySelector('#tokens-line').setAttribute('d', paths.line)
  document.querySelector('#tokens-area').setAttribute('d', paths.area)
  document.querySelector('#tokens-chart').setAttribute('aria-label', `Tokens through the day: ${L.tokens(today.total)} so far today`)
}

/** Hovering the graph shows one hour of today: what it used and the total by then. */
function setupTokenChart() {
  const chart = document.querySelector('#tokens-chart')
  const cursor = document.querySelector('#tokens-cursor')
  const tip = el('div', { class: 'tok-tip', role: 'tooltip', hidden: true })
  document.body.append(tip)
  const hide = () => {
    tip.hidden = true
    cursor.setAttribute('visibility', 'hidden')
  }
  chart.addEventListener('pointermove', event => {
    if (!view.tokens) return
    const box = chart.getBoundingClientRect()
    const hour = L.tokenHour(view.tokens.hours?.today, L.clamp01((event.clientX - box.left) / box.width) * 24, Date.now())
    const x = (((hour.hour + 0.5) / 24) * TOKEN_CHART.width).toFixed(1)
    cursor.setAttribute('x1', x)
    cursor.setAttribute('x2', x)
    cursor.setAttribute('visibility', 'visible')
    tip.replaceChildren(
      el('strong', {}, hour.label),
      hour.used === undefined
        ? el('span', {}, 'Still to come')
        : [el('span', {}, `${L.tokens(hour.used)} this hour`), el('span', { class: 'tok-tip-note' }, `${L.tokens(hour.soFar)} today by then`)],
    )
    tip.hidden = false
    const left = Math.min(Math.max(8, event.clientX - tip.offsetWidth / 2), window.innerWidth - tip.offsetWidth - 8)
    tip.style.left = `${left}px`
    tip.style.top = `${box.bottom + 8}px`
  })
  chart.addEventListener('pointerleave', hide)
  window.addEventListener('blur', hide)
}

// ---------- starting a Claude Code session ----------

const START_PLACE_KEY = 'ccc.startIn'
const START_MODE_KEY = 'ccc.startMode'
// how long after a start from "+" a new card still counts as that session's, for going to it
const STARTED_WAIT_MS = 3 * 60_000
// a card that comes onto the board is gone to, unless the person typed somewhere this recently
const TYPING_MS = 4000

/** The + in the header: pick a folder, the Claude app or the Terminal, and a session starts there. */
function setupStart() {
  const dialog = document.querySelector('#start-dialog')
  const prompt = document.querySelector('#start-prompt')
  view.start = { folder: '', folders: [], where: L.startState({ where: readStored(START_PLACE_KEY) }).where, isStarting: false, mode: 'new', existing: null, search: '' }
  document.querySelector('#start-mode').addEventListener('click', event => {
    const button = event.target.closest('[data-mode]')
    if (!button) return
    view.start.mode = ['existing', 'terminal'].includes(button.dataset.mode) ? button.dataset.mode : 'new'
    document.querySelector('#start-problem').textContent = ''
    drawStart()
    if (view.start.mode === 'existing') loadExisting()
  })
  document.querySelector('#existing-search').addEventListener('input', event => {
    view.start.search = event.target.value
    drawExisting()
  })
  document.querySelector('#new-session').addEventListener('click', async () => {
    document.querySelector('#start-problem').textContent = ''
    prompt.value = ''
    dialog.showModal()
    drawStart()
    try {
      const response = await fetch('/api/folders', { cache: 'no-store' })
      const data = response.ok ? await response.json() : {}
      view.start.folders = Array.isArray(data.folders) ? data.folders.filter(folder => typeof folder === 'string') : []
      if (!view.start.folder) view.start.folder = view.start.folders[0] ?? ''
    } catch {
      view.start.folders = []
    }
    drawStart()
  })
  document.querySelector('#start-folders').addEventListener('click', event => {
    const button = event.target.closest('[data-folder]')
    if (!button) return
    view.start.folder = button.dataset.folder
    drawStart()
  })
  document.querySelector('#start-where').addEventListener('click', event => {
    const button = event.target.closest('[data-where]')
    if (!button) return
    view.start.where = L.startState({ where: button.dataset.where }).where
    writeStored(START_PLACE_KEY, view.start.where)
    drawStart()
    if (view.start.mode === 'new') prompt.focus()
  })
  document.querySelector('#start-pick').addEventListener('click', async event => {
    const button = event.currentTarget
    button.disabled = true
    const { folder, problem } = await pickFolder()
    button.disabled = false
    document.querySelector('#start-problem').textContent = problem
    if (!folder) return
    view.start.folder = folder
    view.start.folders = [folder, ...view.start.folders.filter(one => one !== folder)]
    drawStart()
  })
  // the mode a terminal start gets, as picked last time
  const perm = document.querySelector('#start-perm')
  perm.value = readStored(START_MODE_KEY) ?? ''
  if (perm.selectedIndex < 0) perm.value = ''
  perm.addEventListener('change', () => writeStored(START_MODE_KEY, perm.value))
  document.querySelector('#start-go').addEventListener('click', () => startSession(dialog))
  prompt.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) startSession(dialog)
  })
}

function drawStart() {
  const start = view.start
  const state = L.startState({ ...start, appName: chosenApp().name })
  document.querySelector('#start-folders').replaceChildren(
    ...(start.folders.length
      ? start.folders.map(folder => {
          const label = L.folderLabel(folder)
          const isChosen = folder === start.folder
          return el(
            'button',
            { type: 'button', role: 'radio', class: `start-folder${isChosen ? ' chosen' : ''}`, 'aria-checked': String(isChosen), 'data-folder': folder, title: folder },
            el('span', { class: 'start-folder-name' }, label.name),
            el('span', { class: 'start-folder-path' }, label.parent),
          )
        })
      : [el('p', { class: 'hint' }, 'No folders yet. Choose one.')]),
  )
  const isExisting = start.mode === 'existing'
  const isShell = start.mode === 'terminal'
  const appName = chosenApp().name
  for (const button of document.querySelectorAll('#start-mode [data-mode]')) button.setAttribute('aria-checked', String(button.dataset.mode === start.mode))
  for (const part of document.querySelectorAll('#start-dialog .start-new')) part.hidden = isExisting
  document.querySelector('#start-existing').hidden = !isExisting
  document.querySelector('#start-in').hidden = isExisting || isShell
  document.querySelector('#start-shell-note').hidden = !isShell
  setText('#start-title', isShell ? 'NEW TERMINAL' : 'ADD A SESSION')
  setText('#start-app-name', appName)
  for (const button of document.querySelectorAll('#start-where [data-where]')) button.setAttribute('aria-checked', String(button.dataset.where === state.where))
  setText('#start-note', state.note)
  // only claude in a terminal takes a mode as it starts; the app's link has no way to give one
  const isApp = state.where === 'app'
  document.querySelector('#start-perm').disabled = isApp
  document.querySelector('.start-perm').classList.toggle('is-off', isApp)
  setText(
    '#start-perm-note',
    isApp
      ? 'The Claude app starts every session in its own default mode: its link to start a session has no way to give one. Pick the mode in the app, or set a default in Claude Code\u2019s settings (permissions.defaultMode).'
      : `claude starts in ${appName} in this mode.`,
  )
  // the first message goes with either: typed into the app's new session, or given to claude in the terminal
  document.querySelector('#start-prompt').hidden = isShell
  const go = document.querySelector('#start-go')
  go.hidden = isExisting
  go.disabled = !state.canStart
  go.textContent = start.isStarting ? 'Starting…' : isShell ? 'Open terminal' : state.where === 'app' ? 'Open in the Claude app' : `Start in ${appName}`
}

// ---------- adding a conversation from Claude's history ----------

const WHERE_LABEL = { app: 'Claude app', vscode: 'VS Code', terminal: 'Terminal' }

/** Asks the board's server for the conversations in Claude's history on this Mac. */
async function loadExisting() {
  view.start.existing = null
  drawExisting()
  try {
    const response = await fetch('/api/existing', { cache: 'no-store' })
    const data = response.ok ? await response.json() : {}
    view.start.existing = Array.isArray(data.conversations) ? data.conversations : []
  } catch {
    view.start.existing = []
    document.querySelector('#start-problem').textContent = 'Could not read your conversations. Is the board still running?'
  }
  drawExisting()
  document.querySelector('#existing-search').focus()
}

function drawExisting() {
  const list = document.querySelector('#existing-list')
  const all = view.start.existing
  if (all === null) return list.replaceChildren(el('p', { class: 'hint' }, 'Reading your conversations…'))
  const shown = L.matchConversations(all, view.start.search)
  if (shown.length === 0) return list.replaceChildren(el('p', { class: 'hint' }, all.length ? 'No conversation matches that.' : 'No conversations found on this Mac.'))
  const now = Date.now()
  list.replaceChildren(
    ...shown.map(conversation => {
      const add = el('button', { type: 'button', class: 'primary existing-add', disabled: conversation.onBoard }, conversation.onBoard ? 'On the board' : 'Add to CCC')
      add.addEventListener('click', () => addExisting(conversation, add))
      const open = openExisting(conversation)
      return el(
        'div',
        { class: 'existing-row', role: 'listitem' },
        el(
          'div',
          { class: 'existing-main' },
          el('span', { class: 'existing-title', title: conversation.title }, conversation.title),
          el('span', { class: 'existing-meta', title: conversation.folder }, [L.folderLabel(conversation.folder).name, L.timeAgo(conversation.modifiedAt, now), WHERE_LABEL[conversation.where]].filter(Boolean).join(' · ')),
        ),
        el('div', { class: 'existing-actions' }, open, add),
      )
    }),
  )
}

/** The second way in for a conversation: open it where it lives (the app, VS Code), or pick it up again in a Terminal. */
function openExisting(conversation) {
  const link = L.openLink({ sessionId: conversation.sessionId, appSessionId: conversation.appSessionId, entrypoint: conversation.where === 'vscode' ? 'claude-vscode' : '' })
  if (link) {
    const anchor = el('a', { class: 'secondary existing-open', href: link.href, title: `${link.about}, and add it to CCC` }, conversation.where === 'vscode' ? 'Open in VS Code' : 'Open in app')
    anchor.addEventListener('click', () => addExisting(conversation, null))
    return anchor
  }
  const appName = chosenApp().name
  const resume = el('button', { type: 'button', class: 'secondary existing-open', title: `Opens ${appName} in its folder, picks this conversation up again there, and adds it to CCC` }, `Resume in ${appName}`)
  resume.addEventListener('click', async () => {
    resume.disabled = true
    const problem = document.querySelector('#start-problem')
    try {
      const response = await fetch('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CCC-Action': 'start' }, body: JSON.stringify({ sessionId: conversation.sessionId, resume: true, app: view.settings.terminalApp }) })
      const data = response.ok ? await response.json() : { problem: 'Could not open the Terminal. Is the board still running?' }
      if (!data.ok) problem.textContent = data.problem || 'Could not open the Terminal.'
      else await addExisting(conversation, null)
    } catch {
      problem.textContent = 'Could not open the Terminal. Is the board still running?'
    } finally {
      resume.disabled = false
    }
  })
  return resume
}

/** Puts the conversation on the board, closes the window and brings its chat into view. */
async function addExisting(conversation, button) {
  if (button) button.disabled = true
  const problem = document.querySelector('#start-problem')
  try {
    const response = await fetch('/api/add', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CCC-Action': 'add' }, body: JSON.stringify({ sessionId: conversation.sessionId }) })
    const data = response.ok ? await response.json() : { problem: 'Could not add it. Is the board still running?' }
    if (!data.ok) {
      problem.textContent = data.problem || 'Could not add it.'
      if (button) button.disabled = false
      return
    }
    document.querySelector('#start-dialog').close()
    await poll()
    window.dispatchEvent(new CustomEvent('ccc:show-session', { detail: { sessionId: conversation.sessionId } }))
  } catch {
    problem.textContent = 'Could not add it. Is the board still running?'
    if (button) button.disabled = false
  }
}

/** The Mac's own folder window, opened by the board's server: the folder picked, or why there is none. */
async function pickFolder() {
  try {
    const response = await fetch('/api/pick-folder', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CCC-Action': 'pick' }, body: '{}' })
    const data = response.ok ? await response.json() : {}
    if (typeof data.folder === 'string') return { folder: data.folder, problem: '' }
    return { folder: '', problem: data.busy ? 'The folder window is already open. Look for it behind this window.' : '' }
  } catch {
    return { folder: '', problem: 'Could not open the folder window. Is the board still running?' }
  }
}

async function startSession(dialog) {
  const start = view.start
  if (!L.startState(start).canStart) return
  if (start.mode === 'terminal') return openTerminal(dialog)
  start.isStarting = true
  drawStart()
  const problem = document.querySelector('#start-problem')
  try {
    const response = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CCC-Action': 'start' },
      body: JSON.stringify({ folder: start.folder, where: start.where, prompt: document.querySelector('#start-prompt').value, app: view.settings.terminalApp, mode: document.querySelector('#start-perm').value }),
    })
    const data = response.ok ? await response.json() : { problem: 'Could not start it. Is the board still running?' }
    if (data.ok) {
      dialog.close()
      // the board goes to the session's card once it shows up, at the bottom where it is added
      view.startedAt = Date.now()
    }
    else problem.textContent = data.problem || 'Could not start it.'
  } catch {
    problem.textContent = 'Could not start it. Is the board still running?'
  } finally {
    start.isStarting = false
    drawStart()
  }
}

/** A new shell on the board in the folder picked; the board glides to it and puts the cursor in it. */
async function openTerminal(dialog) {
  const start = view.start
  start.isStarting = true
  drawStart()
  const { id, problem } = await startTerminal(start.folder)
  start.isStarting = false
  drawStart()
  if (!id) {
    document.querySelector('#start-problem').textContent = problem
    return
  }
  dialog.close()
  await poll()
  window.dispatchEvent(new CustomEvent('ccc:show-session', { detail: { sessionId: id } }))
}

/** The terminal app picked in the settings, as this Mac has it. */
function chosenApp() {
  return L.terminalApp(view.settings.terminalApp, view.terminalApps)
}

/** The × on a terminal: an ended one goes at once; a running one asks first, since its shell stops. */
function askToCloseTerminal(id, title, isEnded) {
  const leave = async () => {
    const node = view.tiles.get(id)?.node
    if (view.settings.theme === 'inferno' && view.settings.animations) carryAway(node)
    else node?.classList.add('leaving')
    view.removing.add(id)
    if (!(await closeTerminal(id))) {
      view.removing.delete(id)
      view.tiles.get(id)?.node.classList.remove('leaving', 'carried')
    }
    await poll()
  }
  if (isEnded) return leave()
  const dialog = document.querySelector('#terminal-close-dialog')
  setText('#terminal-close-name', title)
  dialog.returnValue = ''
  dialog.onclose = () => {
    if (dialog.returnValue === 'close') leave()
  }
  dialog.showModal()
  document.querySelector('#terminal-close-confirm').focus()
}

/** A shell started again takes the old card's place and size on the board. */
function moveTerminalPlace(oldId, newId) {
  for (const part of ['cards', 'chats']) {
    if (view.layout[part]?.[oldId]) {
      view.layout[part][newId] = view.layout[part][oldId]
      delete view.layout[part][oldId]
    }
  }
  saveLayout(view.layout)
  poll().then(() => focusTerminal(newId))
}

// what the top bar gives up, first to last, while it does not fit: whole parts, never one cut off
// halfway. The small print and the words beside the switches go before the numbers; the 5-hour and
// weekly limits, the switches, Settings and the clock stay to the end.
const BAR_GIVES_UP = [
  '#stat-agents', '#tokens-chart', '#tokens-yesterday-box', '.tok-open', '#tray-date',
  // the words beside both switches and Settings go together, so the three still look alike
  '#motion-toggle > span:last-child, #freeze-toggle > span:last-child, #settings-open > span',
  '.tok-kinds', '#prompts', '.sum-counts', '.sum-sessions', '#tokens',
]

/** Shows as much of the top bar as it has room for: the overview in it never runs past its edge. */
function fitSummary() {
  const summary = document.querySelector('#summary')
  const bar = document.querySelector('.taskbar')
  const parts = BAR_GIVES_UP.map(selector => [...bar.querySelectorAll(selector)]).filter(nodes => nodes.length)
  for (const nodes of parts) for (const node of nodes) node.classList.remove('fit-hidden')
  for (const nodes of parts) {
    if (summary.scrollWidth <= summary.clientWidth + 1) break
    for (const node of nodes) node.classList.add('fit-hidden')
  }
}

/** Whether a box between the pointer and the page can still move the way the wheel turns. */
function canScrollInside(target, dx, dy) {
  const isDown = Math.abs(dy) >= Math.abs(dx)
  const delta = isDown ? dy : dx
  if (!delta) return false
  for (let node = target instanceof Element ? target : target?.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node)
    const overflow = isDown ? style.overflowY : style.overflowX
    if (!/auto|scroll|overlay/.test(overflow)) continue
    const at = isDown ? node.scrollTop : node.scrollLeft
    const room = isDown ? node.scrollHeight - node.clientHeight : node.scrollWidth - node.clientWidth
    if (room > 1 && (delta < 0 ? at > 0 : at < room - 1)) return true
  }
  return false
}

/** The part of a chat or terminal card that its wheel scrolls: the chat itself, or the terminal's lines. */
function cardScroller(target) {
  const card = target?.closest?.('#sessions .tile')
  return card?.querySelector('.xterm-viewport, .chat-scroll') ?? null
}

/**
 * Hold-to-scroll (a setting): the wheel moves what is under the pointer and never the board, so a
 * board full of chats and terminals stays put while you read; a scroll button held with the wheel
 * moves the board. Shift is one from the start, and the person can add others (an extra mouse button,
 * a key) or remove any. A window over the board (settings, the start window) scrolls as always.
 */
function setupShiftScroll() {
  let wheel = L.WHEEL_START
  // the scroll buttons held down right now, besides Shift: the wheel event says whether Shift is
  const held = new Set()
  const isScrollButton = id => view.settings.shiftScroll && view.settings.scrollButtons.includes(id)
  const hold = (id, isDown) => {
    if (!isScrollButton(id) || isDown === held.has(id)) return
    const wasHeld = held.size > 0
    if (isDown) held.add(id)
    else held.delete(id)
    if (wasHeld !== held.size > 0) wheel = L.shiftChanged(wheel, performance.now())
  }
  const onKey = event => {
    const id = L.scrollButtonOf({ kind: 'key', code: event.code, key: event.key })
    if (id !== L.SHIFT_BUTTON) hold(id, event.type === 'keydown')
    else if (isScrollButton(id)) wheel = L.shiftChanged(wheel, performance.now())
  }
  const onMouse = event => {
    const id = L.scrollButtonOf({ kind: 'mouse', button: event.button })
    if (!isScrollButton(id)) return
    if (event.type !== 'auxclick') hold(id, event.type === 'mousedown')
    // held for scrolling, the back and forward buttons must not change the page, nor the middle one open a link
    event.preventDefault()
  }
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('keyup', onKey, true)
  for (const type of ['mousedown', 'mouseup', 'auxclick']) window.addEventListener(type, onMouse, true)
  // a button let go outside the window is never heard of; leaving the window lets go of it
  window.addEventListener('blur', () => held.clear())
  window.addEventListener(
    'wheel',
    event => {
      if (event.defaultPrevented) return
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1
      const target = event.target
      const isOurs = view.settings.shiftScroll && !event.ctrlKey && !document.querySelector('dialog[open]')
      const buttonHeld = L.scrollButtonHeld(view.settings.scrollButtons, { held, shiftKey: event.shiftKey })
      if (isOurs) {
        // the glide left of a movement a scroll button changed in the middle of goes nowhere
        const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
        const followed = L.followWheel(wheel, { now: performance.now(), shiftKey: buttonHeld, delta: delta * unit })
        wheel = followed.state
        if (followed.drop) return event.preventDefault()
      }
      const goes = L.wheelGoes({
        isOn: view.settings.shiftScroll,
        buttonHeld,
        ctrlKey: event.ctrlKey,
        inWindow: Boolean(document.querySelector('dialog[open]')),
        canScrollInside: !buttonHeld && canScrollInside(target, event.deltaX, event.deltaY),
        inCard: Boolean(cardScroller(target)),
      })
      if (goes === 'default' || goes === 'inside') return
      event.preventDefault()
      if (goes === 'page') {
        // a Mac turns Shift and the wheel into a sideways scroll; the board moves up and down
        const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
        window.scrollBy(0, delta * unit)
      } else if (goes === 'card') {
        cardScroller(target).scrollBy(0, event.deltaY * unit)
      }
    },
    { passive: false },
  )
}

// ---------- the token history window ----------

const HISTORY_PERIOD_KEY = 'ccc.tokenPeriod'
const HISTORY_KIND_KEY = 'ccc.tokenKind'
const HISTORY_REFRESH_MS = 30_000
// room around the graph: the values on the left, the average on the right, the days under it
const GRAPH_PAD = { top: 16, right: 62, bottom: 30, left: 58 }
// the width a day under the graph takes, so the labels never run into each other
const GRAPH_LABEL_ROOM = 64
// a dot on each point while there are few enough to tell apart
const GRAPH_DOTS_UP_TO = 14

/** Clicking the tokens in the header opens their history: one kind at a time, over the period the person picks. */
function setupTokenHistory() {
  const dialog = document.querySelector('#tokens-history')
  view.historyPeriod = L.tokenPeriod(readStored(HISTORY_PERIOD_KEY)).id
  view.historyKind = L.tokenKind(readStored(HISTORY_KIND_KEY)).key
  const select = document.querySelector('#th-period')
  select.replaceChildren(...L.TOKEN_PERIODS.map(period => el('option', { value: period.id }, period.label)))
  select.value = view.historyPeriod
  select.addEventListener('change', () => {
    view.historyPeriod = L.tokenPeriod(select.value).id
    writeStored(HISTORY_PERIOD_KEY, view.historyPeriod)
    loadHistory()
  })
  const tabs = document.querySelector('#th-kinds')
  tabs.addEventListener('click', event => {
    const tab = event.target.closest('[data-kind]')
    if (tab) pickKind(tab.dataset.kind)
  })
  // the arrow keys move between the kinds, as in any row of tabs
  tabs.addEventListener('keydown', event => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key]
    if (!step) return
    event.preventDefault()
    const keys = L.TOKEN_KINDS.map(kind => kind.key)
    const next = keys[(keys.indexOf(view.historyKind) + step + keys.length) % keys.length]
    pickKind(next)
    tabs.querySelector(`[data-kind="${next}"]`)?.focus()
  })
  document.querySelector('#tokens').addEventListener('click', () => {
    dialog.showModal()
    loadHistory()
  })
  document.querySelector('#th-close').addEventListener('click', () => dialog.close())
  // a click on the dimmed board around the window closes it
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close()
  })
  dialog.addEventListener('close', () => {
    document.querySelector('#th-tip').hidden = true
  })
  window.addEventListener('resize', () => dialog.open && drawHistory())
  setInterval(() => dialog.open && loadHistory(), HISTORY_REFRESH_MS)
}

function pickKind(key) {
  view.historyKind = L.tokenKind(key).key
  writeStored(HISTORY_KIND_KEY, view.historyKind)
  drawHistory()
}

async function loadHistory() {
  const period = L.tokenPeriod(view.historyPeriod)
  document.querySelector('#th-period').value = period.id
  try {
    const response = await fetch(`/api/tokens/history?days=${period.days}`, { cache: 'no-store' })
    if (!response.ok) return
    const data = await response.json()
    if (!Array.isArray(data?.days) || !Array.isArray(data?.hours)) return
    view.history = data
    drawHistory()
  } catch {
    // the window keeps what it showed until the server answers again
  }
}

function drawHistory() {
  const data = view.history
  if (!data) return
  const periodId = L.tokenPeriod(view.historyPeriod).id
  const kind = L.tokenKind(view.historyKind)
  const stats = L.historyStats(data, periodId, kind.key)
  drawKindTabs(data, periodId, kind)
  document.querySelector('#th-graph-title').replaceChildren(
    el('strong', {}, `${kind.label} tokens`),
    el('span', {}, `${kind.note}, ${periodId === 'today' ? 'per hour today' : 'per day'}`),
  )
  drawHistoryGraph(kind, L.historySeries(data, periodId, kind.key), periodId, stats.average)
  drawHistoryStats(stats, periodId)
  const note = L.historyNote(data, periodId)
  const noteNode = document.querySelector('#th-note')
  noteNode.hidden = !note
  noteNode.textContent = note
  drawHistoryTable(data, periodId)
}

/** The kinds as tabs, each with what it came to over the period; the picked one's graph is under them. */
function drawKindTabs(data, periodId, picked) {
  const totals = L.historyTotals(data, periodId)
  const tabs = document.querySelector('#th-kinds')
  // the tabs are drawn again, so a tab that had the keyboard gets it back
  const hadFocus = tabs.contains(document.activeElement)
  tabs.replaceChildren(
    ...L.TOKEN_KINDS.map(kind => {
      const isPicked = kind.key === picked.key
      const { sum, share } = totals[kind.key]
      return el(
        'button',
        { type: 'button', role: 'tab', id: `th-tab-${kind.key}`, class: 'th-tab', 'data-kind': kind.key, 'aria-selected': String(isPicked), 'aria-controls': 'th-page', tabindex: isPicked ? '0' : '-1' },
        el('span', { class: 'th-tab-label' }, kind.label),
        el('span', { class: 'th-tab-value', title: `${sum.toLocaleString('en-GB')} tokens` }, L.tokens(sum)),
        el('span', { class: 'th-tab-note' }, kind.key === 'total' ? 'all kinds together' : L.shareOfAll(share)),
      )
    }),
  )
  if (hadFocus) tabs.querySelector('[aria-selected="true"]')?.focus()
  document.querySelector('#th-page').setAttribute('aria-labelledby', `th-tab-${picked.key}`)
}

/** The picked kind over the period as a line on round steps, with its average as a dashed line. */
function drawHistoryGraph(kind, series, periodId, average) {
  const plot = document.querySelector('#th-plot')
  const tip = document.querySelector('#th-tip')
  // a tooltip from the graph drawn before would show a value no longer there
  tip.hidden = true
  const width = Math.max(260, Math.floor(plot.clientWidth))
  const height = Math.max(180, Math.floor(plot.clientHeight))
  const pad = GRAPH_PAD
  const inner = { w: width - pad.left - pad.right, h: height - pad.top - pad.bottom }
  const base = pad.top + inner.h
  const shown = series.filter(item => !item.isToCome)
  const scale = L.niceScale(Math.max(0, ...shown.map(item => item.value)))
  const yOf = value => (scale.max > 0 ? base - (value / scale.max) * inner.h : base)
  const points = L.linePoints(
    series.map(item => item.value),
    inner.w,
    inner.h,
    scale.max,
  ).map(point => ({ x: point.x + pad.left, y: point.y + pad.top }))
  const drawn = points.slice(0, shown.length)
  const about = periodId === 'today' ? 'by hour today' : `by day, ${L.tokenPeriod(periodId).label.toLowerCase()}`
  const chart = svg('svg', { class: 'th-graph', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${kind.label} tokens ${about}` })
  const fill = svg('linearGradient', { id: 'th-fill', x1: 0, x2: 0, y1: 0, y2: 1 })
  fill.append(svg('stop', { class: 'th-fill-top', offset: '0%' }), svg('stop', { class: 'th-fill-bottom', offset: '100%' }))
  const defs = svg('defs')
  defs.append(fill)
  chart.append(defs)
  for (const tick of scale.ticks) {
    const y = Math.round(yOf(tick)) + 0.5
    chart.append(svg('line', { class: tick === 0 ? 'th-base' : 'th-grid', x1: pad.left, x2: width - pad.right, y1: y, y2: y }))
    chart.append(svg('text', { class: 'th-tick', x: pad.left - 10, y: y + 4, 'text-anchor': 'end' }, L.tokens(tick)))
  }
  for (const { index, label } of L.axisTicks(series, periodId, Math.floor(inner.w / GRAPH_LABEL_ROOM))) {
    const anchor = index === 0 ? 'start' : index === series.length - 1 ? 'end' : 'middle'
    chart.append(svg('text', { class: 'th-tick', x: points[index].x, y: height - 8, 'text-anchor': anchor }, label))
  }
  if (scale.max === 0) {
    chart.append(svg('text', { class: 'th-empty', x: pad.left + inner.w / 2, y: pad.top + inner.h / 2, 'text-anchor': 'middle' }, 'No tokens in this period'))
  } else {
    chart.append(svg('path', { class: 'th-area', d: L.linePath(drawn, base).area }))
    // the last stretch runs to now, which is not over yet, so it is dashed
    const isOpenEnded = drawn.length > 1 && shown[shown.length - 1].isNow
    chart.append(svg('path', { class: 'th-line', d: L.linePath(isOpenEnded ? drawn.slice(0, -1) : drawn, base).line }))
    if (isOpenEnded) chart.append(svg('path', { class: 'th-line open', d: L.linePath(drawn.slice(-2), base).line }))
    if (shown.length > 1 && average > 0) {
      const y = Math.round(yOf(average)) + 0.5
      // named to the right of the graph, where no point of the line can cover it
      chart.append(svg('line', { class: 'th-average', x1: pad.left, x2: width - pad.right + 4, y1: y, y2: y }))
      chart.append(svg('text', { class: 'th-average-label', x: width - pad.right + 8, y: y - 3 }, 'average'))
      chart.append(svg('text', { class: 'th-average-value', x: width - pad.right + 8, y: y + 11 }, L.tokens(Math.round(average))))
    }
    if (drawn.length <= GRAPH_DOTS_UP_TO) for (const point of drawn) chart.append(svg('circle', { class: 'th-dot', cx: point.x, cy: point.y, r: 4 }))
  }
  const guide = svg('line', { class: 'th-guide', y1: pad.top, y2: base, visibility: 'hidden' })
  const focus = svg('circle', { class: 'th-focus', r: 5, visibility: 'hidden' })
  chart.append(guide, focus)
  chart.addEventListener('pointermove', event => {
    if (drawn.length === 0) return
    const box = chart.getBoundingClientRect()
    const i = L.nearestPoint(event.clientX - box.left - pad.left, inner.w, series.length, drawn.length - 1)
    const point = drawn[i]
    const item = series[i]
    for (const [name, value] of [['x1', point.x], ['x2', point.x], ['visibility', 'visible']]) guide.setAttribute(name, value)
    for (const [name, value] of [['cx', point.x], ['cy', point.y], ['visibility', 'visible']]) focus.setAttribute(name, value)
    const when = item.isNow ? `${item.label}, ${periodId === 'today' ? 'this hour so far' : 'today so far'}` : item.label
    tip.replaceChildren(el('strong', {}, when), el('span', {}, `${kind.label}: ${L.tokens(item.value)}`), el('span', { class: 'tok-tip-note' }, `${item.value.toLocaleString('en-GB')} tokens`))
    tip.hidden = false
    const left = Math.min(Math.max(8, box.left + point.x - tip.offsetWidth / 2), window.innerWidth - tip.offsetWidth - 8)
    const above = box.top + point.y - tip.offsetHeight - 14
    tip.style.left = `${left}px`
    tip.style.top = `${above >= 8 ? above : box.top + point.y + 14}px`
  })
  chart.addEventListener('pointerleave', () => {
    guide.setAttribute('visibility', 'hidden')
    focus.setAttribute('visibility', 'hidden')
    tip.hidden = true
  })
  plot.replaceChildren(chart)
}

/** The figures under the graph: the average, the busiest day or hour, and how far now has got. */
function drawHistoryStats(stats, periodId) {
  const isToday = periodId === 'today'
  const span = isToday ? `over ${stats.spanned} ${stats.spanned === 1 ? 'hour' : 'hours'} so far` : `over ${stats.spanned} ${stats.spanned === 1 ? 'day' : 'days'}`
  const cells = [
    [isToday ? 'Average an hour' : 'Average a day', L.tokens(Math.round(stats.average)), span],
    [isToday ? 'Busiest hour' : 'Busiest day', stats.peak ? L.tokens(stats.peak.value) : '–', stats.peak?.label ?? 'nothing yet'],
    [isToday ? 'This hour' : 'Today', L.tokens(stats.now), 'so far, not over yet'],
  ]
  document.querySelector('#th-stats').replaceChildren(
    ...cells.map(([label, value, note]) => el('div', { class: 'th-stat' }, el('span', { class: 'th-stat-label' }, label), el('span', { class: 'th-stat-value' }, value), el('span', { class: 'th-stat-note' }, note))),
  )
}

/** The same numbers as a table, newest first, for reading them exactly. */
function drawHistoryTable(data, periodId) {
  const rows = periodId === 'today' ? data.hours.map((row, i) => ({ ...row, label: `${String(i).padStart(2, '0')}:00` })).slice(0, (data.hour ?? 23) + 1) : data.days.map(row => ({ ...row, label: L.shortDay(row.day) }))
  document.querySelector('#th-table').replaceChildren(
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, periodId === 'today' ? 'Hour' : 'Day'), ...L.TOKEN_KINDS.map(kind => el('th', { scope: 'col' }, kind.label)))),
    el('tbody', {}, ...[...rows].reverse().map(row => el('tr', {}, el('th', { scope: 'row' }, row.label), ...L.TOKEN_KINDS.map(kind => el('td', {}, (row[kind.key] ?? 0).toLocaleString('en-GB')))))),
  )
}

/** A choice kept in this browser only; a blocked storage leaves the default. */
function readStored(key) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // the choice holds until the page reloads
  }
}

function setArc(selector, segment) {
  const arc = document.querySelector(selector)
  arc.setAttribute('stroke-dasharray', segment ? segment.dash : `0 ${2 * Math.PI * 40}`)
  arc.setAttribute('stroke-dashoffset', segment ? segment.offset : 0)
}

/** Always the 5-hour and weekly cards, so the row never jumps while readings come and go. */
function renderLimits(limits, now) {
  const byKind = new Map(limits.map(limit => [limit.kind, limit]))
  const kinds = [...LIMIT_KINDS, ...limits.map(limit => limit.kind).filter(kind => !LIMIT_KINDS.includes(kind))]
  document.querySelector('#limits').replaceChildren(
    ...kinds.map(kind => {
      const limit = byKind.get(kind)
      const name = limitTitle(kind)
      if (!limit) return limitChip(name, 0, '–', 'no reading yet', false)
      const percent = Math.round(limit.percentUsed)
      const isWarn = percent >= WARN_PERCENT
      const reset = limit.resetsAt ? resetText(limit.resetsAt, now) : ''
      return limitChip(name, percent, `${percent}%`, reset ? `resets ${reset}` : '', isWarn)
    }),
  )
}

/** One usage limit in the header: a small ring, how much is used, and when it starts over. */
function limitChip(name, percent, label, note, isWarn) {
  return el(
    'div',
    { class: `sum sum-limit${isWarn ? ' warn' : ''}`, title: `${name}: ${label === '–' ? 'no reading yet' : `${label} used`}${note ? `, ${note}` : ''}` },
    ring({ size: 30, radius: 11, width: 4, percent, stroke: isWarn ? 'url(#g-wait)' : 'url(#g-ok)', label: '', alt: `${name}: ${label === '–' ? 'no reading yet' : `${label} used`}`, className: 'sum-ring' }),
    el('span', { class: 'sum-lines' }, el('span', { class: 'sum-label' }, limitShort(name)), el('span', { class: 'sum-value small' }, label)),
    note ? el('span', { class: 'sum-note' }, note) : null,
  )
}

function limitShort(name) {
  return /5/.test(name) ? '5H' : /week/i.test(name) ? 'WEEK' : name
}

function limitTitle(kind) {
  if (kind === 'five_hour') return '5H LIMIT'
  if (kind === 'seven_day') return 'WEEKLY LIMIT'
  return L.limitName(kind)
}

function resetText(resetsAt, now) {
  const at = new Date(resetsAt)
  if (Number.isNaN(at.getTime())) return ''
  if (at.getTime() - now < 24 * 3_600_000) return L.clock(at.getTime()).slice(0, 5)
  return at.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + L.clock(at.getTime()).slice(0, 5)
}

// ---------- session cards ----------

function renderTiles(sessions, now, day, tags) {
  if (view.isInteracting) return
  const box = document.querySelector('#sessions')
  const seen = new Set()
  const arranged = L.arrangeSessions(sessions, view.layout.order)
  // every session is always open into its chat, as the app shows it: there is no small card
  for (const session of arranged) view.expanded.add(session.sessionId)
  const arriving = new Set(L.arrivals(view.onBoard, arranged.map(session => session.sessionId)))
  arranged.forEach((session, index) => {
    const id = session.sessionId
    const state = L.sessionState(session, now)
    const color = L.identityColor(view.slots, id)
    const today = L.spentOn(session, day)
    const newest = newestKey(session)
    const isFresh = view.newestLog.has(id) && newest !== view.newestLog.get(id)
    const signature = JSON.stringify({ ...session, updatedAt: 0, state, color, today, tag: tags.get(id) })
    let tile = view.tiles.get(id)
    if (view.expanded.has(id)) {
      // an expanded card is made once and kept, so what is being typed in it stays
      if (!tile?.isChat) {
        const node = chatCard(id)
        tile?.node.replaceWith(node)
        tile = { node, signature: '', isChat: true }
        view.tiles.set(id, tile)
      }
      view.grid.hold(id, tile.node)
      view.newestLog.set(id, newest)
      seen.add(id)
      return
    }
    const isRedrawn = !tile || tile.isChat || tile.signature !== signature
    if (isRedrawn) {
      const node = drawTile(session, { state, color, today, title: tags.get(id), isFresh, now })
      tile?.node.replaceWith(node)
      tile = { node, signature }
      view.tiles.set(id, tile)
    }
    view.grid.hold(id, tile.node)
    if (isRedrawn) followBoxes(tile.node, id)
    if (isFresh) popBubble(tile.node)
    view.newestLog.set(id, newest)
    seen.add(id)
  })
  // the terminals come after the sessions, each a card made once and kept, like a chat
  const shells = view.terminals.filter(card => !view.removing.has(card.id))
  shells.forEach((card, offset) => {
    const index = arranged.length + offset
    let tile = view.tiles.get(card.id)
    if (!tile) {
      tile = { node: terminalCard(card), signature: '', isChat: true, isTerminal: true }
      view.tiles.set(card.id, tile)
    }
    updateTerminal(card)
    view.grid.hold(card.id, tile.node)
    seen.add(card.id)
  })
  for (const id of L.arrivals(view.onBoard, shells.map(card => card.id))) arriving.add(id)
  for (const [id, tile] of view.tiles) {
    if (seen.has(id)) continue
    view.grid.drop(id)
    if (tile.isChat) dropChat(id)
    if (tile.isTerminal) dropTerminal(id)
    view.tiles.delete(id)
    view.newestLog.delete(id)
  }
  document.querySelector('#sessions-empty').hidden = sessions.length + shells.length > 0
  view.order = [...arranged.map(session => session.sessionId), ...shells.map(card => card.id)]
  view.onBoard = seen
  if (view.settings.animations) for (const id of arriving) welcome(view.tiles.get(id)?.node, view.settings.theme)
  // a card that comes onto the board while it is open (a new session, a terminal, one added from
  // history) is shown: the board glides to it. Not while the person is typing in another card, unless
  // they started it from "+", which comes in a little later.
  const started = [...arriving].find(id => !id.startsWith('t'))
  const isOwnStart = Boolean(started && view.startedAt && Date.now() - view.startedAt < STARTED_WAIT_MS)
  if (isOwnStart) view.startedAt = 0
  const newest = isOwnStart ? started : [...arriving].at(-1)
  if (newest && (isOwnStart || Date.now() - view.typedAt > TYPING_MS)) {
    setTimeout(() => window.dispatchEvent(new CustomEvent('ccc:show-session', { detail: { sessionId: newest } })), 300)
  }
}

/**
 * The boxes on a card that scroll (Claude's reply, the chat) follow their newest line. Once the
 * person scrolls up in one it stays where they put it, through every redraw, until they scroll
 * back down to the bottom.
 */
function followBoxes(tileNode, sessionId) {
  for (const box of tileNode.querySelectorAll('[data-follow]')) {
    const key = `${sessionId}:${box.dataset.follow}`
    box.scrollTop = L.scrollAfterRedraw(view.follow.get(key), box.scrollHeight)
    box.addEventListener('scroll', () => view.follow.set(key, { isAtBottom: L.isAtBottom(box), top: box.scrollTop }), { passive: true })
  }
}

function newestKey(session) {
  const newest = L.recentLog(session, 1)[0]
  return newest ? `${newest.id}:${newest.at}:${newest.status}` : ''
}

function drawTile(session, { state, color, today, title, isFresh, now }) {
  const branch = session.branch
  const isProtected = branch && L.isProtectedBranch(branch)
  const stats = session.stats ?? {}
  const pill = { working: 'pill-work live', 'needs-you': 'pill-wait live-wait', done: 'pill-done', stale: 'pill-idle', ended: 'pill-idle' }[state]
  const activity = L.activityOf(session, now)
  const runs = L.shownRuns(session.runs, view.layout.runsClearedAt)
  const card = view.layout.cards[session.sessionId] ?? {}
  const isLarge = !card.collapsed && view.settings.cardSize === 'large'
  const classes = ['glass', 'tile', `state-${state}`, card.collapsed && 'collapsed', isLarge && 'large'].filter(Boolean).join(' ')

  const tile = el(
    'article',
    { class: classes, 'data-session': session.sessionId, 'aria-label': `${title}: ${activity.label.toLowerCase()}` },
    el(
      'div',
      { class: 'tile-head' },
      el('span', { class: 'dot', style: `background:${color}`, 'aria-hidden': 'true' }),
      el('span', { class: 'tile-title', title: session.turn?.topic ?? title }, title),
      el('span', { class: `pill ${pill}` }, L.STATE_LABEL[state]),
      windowControls(session.sessionId, title, card),
    ),
    el(
      'div',
      { class: 'where' },
      sourceTag(L.sourceOf(session)),
      el('span', {}, session.folder),
      branch && el('span', { class: `branch${isProtected ? ' danger' : ''}` }, isProtected ? `⚠ ${branch}` : branch),
      openButton(L.openLink(session)),
    ),
    el(
      'dl',
      { class: 'facts' },
      fact('MODEL', L.modelName(stats.model) || '–'),
      fact('EFFORT', stats.effort || '–'),
      fact('TODAY', L.usd(today)),
    ),
    activityLine(activity),
    el('div', { class: 'gauges' }, contextGauge(session.context), progressGauge(session.plan)),
    planList(session.plan),
    isLarge ? chatSection(session) : replyBox(session, REPLY_LINES),
    nextStepRow(session),
    liveTerminal(session, isLarge ? LIVE_LINES.large : LIVE_LINES.compact, isFresh),
    isLarge ? agentList(runs) : el('div', { class: 'chips' }, agentChips(runs)),
    isLarge ? null : tileLog(session),
    ...cornerGrips(),
  )
  return tile
}

/** A grip in each corner of a card, to pull it bigger or smaller from any of them. */
function cornerGrips() {
  return [
    el('span', { class: 'grip', 'aria-hidden': 'true' }),
    el('span', { class: 'grip grip-bl', 'data-axis': 'corner-bl', 'aria-hidden': 'true' }),
    el('span', { class: 'grip grip-tr', 'data-axis': 'corner-tr', 'aria-hidden': 'true' }),
    el('span', { class: 'grip grip-tl', 'data-axis': 'corner-tl', 'aria-hidden': 'true' }),
  ]
}

const ICONS = {
  fold: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 9h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  unfold: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  grow: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2.5" width="8" height="7" rx="1" stroke="currentColor" stroke-width="1.8" fill="none"/></svg>',
}

/** Fold, make big, and remove: in Aero they look like a Windows 7 window's caption buttons. */
function windowControls(sessionId, title, card) {
  const button = (kind, label, icon, onClick) => {
    const node = el('button', { class: `win-button win-${kind}`, type: 'button', 'aria-label': label, title: label })
    node.innerHTML = icon
    node.addEventListener('click', onClick)
    return node
  }
  return el(
    'span',
    { class: 'win-controls' },
    button('fold', card.collapsed ? `Unfold ${title}` : `Fold ${title}`, card.collapsed ? ICONS.unfold : ICONS.fold, () =>
      setCard(sessionId, now => ({ collapsed: !now.collapsed })),
    ),
    button('grow', `Open ${title} into its chat`, ICONS.grow, () => expandCard(sessionId)),
    removeButton(sessionId, title),
  )
}

/**
 * The last few exchanges, so a big card reads like the chat itself. The answer being written
 * grows in its place live, and the box keeps its newest line in view.
 */
function chatSection(session) {
  const chat = (session.chat ?? []).slice(-CHAT_SHOWN)
  if (chat.length === 0) {
    return el('div', { class: 'chat' }, el('p', { class: 'note' }, 'The chat shows up after the next message (sessions started before this update need a restart).'))
  }
  const reply = L.liveReply(session)
  const lines = chat.flatMap((turn, i) => [
    el('p', { class: 'chat-you' }, el('span', { class: 'who' }, 'You'), el('span', { class: 'chat-text' }, turn.prompt)),
    claudeSays(turn, i === chat.length - 1 ? reply : null),
  ])
  return el('div', { class: 'chat', role: 'log', 'aria-label': 'Recent chat', tabindex: '0', 'data-follow': 'chat' }, lines.filter(Boolean))
}

function claudeSays(turn, reply) {
  const line = (text, extra = '', caret = false) =>
    el('p', { class: `chat-claude${extra}` }, el('span', { class: 'who' }, 'Claude'), el('span', { class: 'chat-text' }, text, caret ? el('span', { class: 'reply-caret', 'aria-hidden': 'true' }) : null))
  if (turn.answer) return line(turn.answer)
  if (turn.endedAt) return null
  if (reply?.text) return line(reply.text, ' streaming', reply.state === 'writing')
  return line('working on it…', ' pending')
}

/** Every agent on its own line: what it is, how it stands, for how long, and its last action. A workflow's agents sit under it. */
function agentList(runs) {
  if (runs.length === 0) return el('div', { class: 'chips' }, el('span', { class: 'note' }, 'no agents'))
  return el(
    'ul',
    { class: 'agent-list' },
    L.mapRows(runs).map(({ run, depth, status, agents }) =>
      el(
        'li',
        { class: `run-${status}${depth ? ' child' : ''}` },
        el('span', { class: 'agent-name' }, `${RUN_MARK[status] ?? '•'} ${run.label}`),
        el('span', { class: 'agent-meta' }, `${L.RUN_LABEL[status]} · `, since(run.startedAt, run.endedAt), agents ? ` · ${agentCount(agents)}` : '', run.lastAction && !agents ? ` · ${run.lastAction}` : ''),
      ),
    ),
  )
}

function agentCount(count) {
  return count === 1 ? '1 agent' : `${count} agents`
}


const CROSS_ICON =
  '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'

function removeButton(sessionId, title) {
  const button = el('button', { class: 'win-button win-close remove-button', type: 'button', 'aria-label': `Remove ${title} from CCC`, title: 'Remove from CCC' })
  button.innerHTML = CROSS_ICON
  button.addEventListener('click', () => askToRemove(sessionId, title))
  return button
}

/**
 * Asks what to do: close it from CCC alone (it goes on where it runs), or clear its context too.
 * On either the card leaves at once and the server remembers it is off the board.
 */
function askToRemove(sessionId, title) {
  const dialog = document.querySelector('#remove-dialog')
  setText('#remove-name', title)
  const end = document.querySelector('#remove-end')
  const why = L.endProblem(view.byId.get(sessionId))
  end.disabled = Boolean(why)
  setText('#remove-end-note', why || 'Stops Claude, then runs /clear in the session, so it starts over with an empty context. The old conversation stays in Claude\u2019s history. CCC closes it too.')
  dialog.returnValue = ''
  dialog.onclose = async () => {
    const choice = dialog.returnValue
    if (choice !== 'remove' && choice !== 'end') return
    const node = view.tiles.get(sessionId)?.node
    if (view.settings.theme === 'inferno' && view.settings.animations) carryAway(node)
    else node?.classList.add('leaving')
    view.removing.add(sessionId)
    try {
      const response = await fetch(choice === 'end' ? '/api/end' : '/api/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CCC-Action': choice === 'end' ? 'end' : 'remove' },
        body: JSON.stringify({ sessionId }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch {
      view.removing.delete(sessionId)
      view.tiles.get(sessionId)?.node.classList.remove('leaving', 'carried')
    }
  }
  dialog.showModal()
  document.querySelector('#remove-confirm').focus()
}

/** The live status: animated dots, what it is doing, and for how long, like Claude Code's own. */
function activityLine(activity) {
  return el(
    'p',
    { class: `activity kind-${activity.kind}`, role: 'status' },
    el('span', { class: 'spinner', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')),
    el('span', { class: 'what' }, activity.label),
    activity.since ? [el('span', { class: 'time', 'aria-hidden': 'true' }, '·'), since(activity.since, undefined, { class: 'time' })] : null,
    activity.text ? el('span', { class: 'detail', title: activity.text }, activity.text) : null,
  )
}

/**
 * The session's latest log lines as a small live terminal, newest at the bottom: a call still
 * running blinks and counts its seconds. It always has the same number of rows, so the card
 * never changes height and nothing below it moves.
 */
/**
 * The end of Claude's latest reply, a few lines tall, the newest words at the bottom; a caret
 * blinks while text comes in. Fixed height, like the terminal under it.
 */
function replyBox(session, rows) {
  const { state, text } = L.liveReply(session)
  const earlier = L.earlierAnswer(session)
  return el(
    'div',
    { class: `live-reply reply-${state}`, style: `--rows:${rows}`, role: 'log', 'aria-label': 'Claude’s latest answer', 'aria-live': 'polite', tabindex: '0', 'data-follow': 'reply' },
    el(
      'p',
      { class: 'reply-text' },
      earlier ? el('span', { class: 'reply-earlier' }, `${earlier}\n`) : null,
      text || el('span', { class: 'reply-note' }, REPLY_NOTES[state] ?? ''),
      state === 'writing' ? el('span', { class: 'reply-caret', 'aria-hidden': 'true' }) : null,
    ),
  )
}

/**
 * The answers the next-step box offers, as buttons on the card: a click sends that answer to the
 * session, as the button in the app does. The question itself stands in the line above.
 */
function nextStepRow(session) {
  const next = L.openNextStep(session)
  if (!next) return null
  const id = session.sessionId
  const endedAt = session.turn.endedAt
  const sent = sentChoices.get(id)
  const isSent = sent?.endedAt === endedAt
  const buttons = next.choices.map((choice, i) => {
    const button = el('button', { type: 'button', class: `next-choice${i === 0 ? ' first' : ''}${isSent && sent.label === choice.label ? ' sent' : ''}`, title: choice.message, disabled: isSent }, choice.label)
    button.addEventListener('click', async () => {
      sentChoices.set(id, { endedAt, label: choice.label })
      redrawCard(id)
      if (!(await sendText(id, choice.message))) {
        sentChoices.set(id, { endedAt: -1, label: '', problem: 'Could not send it. Is the board still running?' })
        redrawCard(id)
      }
    })
    return button
  })
  const note = sent?.problem || (isSent ? 'Sent. Claude takes it in a moment.' : '')
  return el(
    'div',
    { class: 'next-step', 'aria-label': next.question ? `Answer: ${next.question}` : 'Answer Claude' },
    el('div', { class: 'next-choices' }, buttons),
    note ? el('span', { class: `next-note${sent?.problem ? ' problem' : ''}`, role: 'status' }, note) : null,
  )
}

/** Draws one card again at the next render, though nothing in its session changed. */
function redrawCard(id) {
  const tile = view.tiles.get(id)
  if (tile && !tile.isChat) tile.signature = ''
  rerender()
}

function liveTerminal(session, rows, isFresh) {
  const slots = L.terminalLines(session, rows)
  const isEmpty = slots.every(entry => entry === null)
  const lines = slots.map((entry, i) => {
    const isLast = i === slots.length - 1
    if (entry) return liveLine(entry, isFresh && isLast)
    if (isEmpty && isLast) return el('li', { class: 'live-line idle' }, 'nothing in the log yet')
    return el('li', { class: 'live-line blank', 'aria-hidden': 'true' }, ' ')
  })
  return el('ol', { class: 'live-terminal', style: `--rows:${rows}`, 'aria-label': 'Latest activity', 'aria-live': 'polite' }, lines)
}

function liveLine(entry, isFresh) {
  const isRunning = entry.status === 'running'
  return el(
    'li',
    { class: `live-line status-${entry.status}${isFresh ? ' fresh' : ''}`, title: entry.text },
    el('span', { class: 'time' }, L.clock(entry.at)),
    isRunning
      ? el('span', { class: 'mark running-dots', 'aria-label': 'running' }, el('i'), el('i'), el('i'))
      : el('span', { class: 'mark', 'aria-label': entry.status }, LOG_MARK[entry.status] ?? '?'),
    el('span', { class: 'text' }, entry.who ? [el('span', { class: 'who' }, `[${clip(entry.who, 16)}] `), entry.text] : entry.text),
    isRunning ? since(entry.at, undefined, { class: 'took' }) : null,
  )
}

function contextGauge(context) {
  if (!context) return gauge(ring({ ...SMALL_RING, percent: 0, stroke: 'url(#g-ok)', label: '–', alt: 'Context: no reading yet' }), 'CONTEXT', 'no reading yet')
  const isWarn = context.percent >= WARN_PERCENT
  return gauge(
    ring({ ...SMALL_RING, percent: context.percent, stroke: isWarn ? 'url(#g-wait)' : 'url(#g-ok)', label: `${context.percent}%`, alt: `Context ${context.percent}% full` }),
    'CONTEXT',
    `${isWarn ? '⚠ ' : ''}${L.tokens(context.tokens)}/${L.tokens(context.window)}`,
  )
}

function progressGauge(plan) {
  const progress = L.planProgress(plan)
  const percent = progress.total === 0 ? 0 : (progress.done / progress.total) * 100
  const label = progress.total === 0 ? '–' : `${progress.done}/${progress.total}`
  const value = progress.total === 0 ? 'no tasks' : progress.done === progress.total ? 'all done' : `${progress.done} of ${progress.total}`
  const alt = progress.total === 0 ? 'No task list' : `${progress.done} of ${progress.total} steps done`
  return gauge(ring({ ...SMALL_RING, percent, stroke: 'url(#g-work)', label, alt }), 'PROGRESS', value)
}

function gauge(ringNode, label, value) {
  return el(
    'div',
    { class: 'gauge' },
    ringNode,
    el('div', { class: 'gauge-text' }, el('span', { class: 'label' }, label), el('span', { class: 'value', title: value }, value)),
  )
}

/** The whole task list, as the Claude app shows it: one line per step, so the card grows downward, never wider. */
function planList(plan) {
  const steps = plan ?? []
  if (steps.length === 0) return el('p', { class: 'step muted' }, 'no task list')
  return el(
    'ol',
    { class: 'plan-list', 'aria-label': 'Task list' },
    steps.map(step =>
      el(
        'li',
        { class: `plan-step step-${step.status}`, title: step.text },
        el('span', { class: 'plan-mark', 'aria-label': step.status.replace('_', ' ') }, PLAN_MARK[step.status] ?? ''),
        el('span', { class: 'plan-text' }, step.text),
      ),
    ),
  )
}

/** Opens the card's chat where it runs: the Claude app or VS Code. */
function openButton(link) {
  if (!link) return null
  const icon = svg('svg', { width: 11, height: 11, viewBox: '0 0 16 16', 'aria-hidden': 'true' })
  icon.append(svg('path', { d: 'M9 2h5v5M14 2 7 9M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
  return el('a', { class: 'open-link', href: link.href, title: link.about, 'aria-label': link.about }, 'Open', icon)
}

const SOURCE_ICONS = {
  app: 'M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2',
  vscode: 'M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4',
  terminal: 'M2 4l4 4-4 4M8 12h6',
}

/**
 * What a card tells about its session, for the side of its chat window: what it does now, model,
 * effort and today's spend, context and progress, the task list, the terminal and the agents.
 */
function chatStats(session, now) {
  if (!session) return { signature: 'none', node: el('p', { class: 'note' }, 'This session is no longer on the board.') }
  const cleared = view.layout.runsClearedAt
  const signature = JSON.stringify({ ...session, updatedAt: 0, cleared })
  const stats = session.stats ?? {}
  const runs = L.shownRuns(session.runs, cleared)
  const node = el(
    'div',
    { class: 'chat-stats' },
    activityLine(L.activityOf(session, now)),
    el('dl', { class: 'facts' }, fact('MODEL', L.modelName(stats.model) || '–'), fact('EFFORT', stats.effort || '–'), fact('TODAY', L.usd(L.spentOn(session, L.dayOf(now))))),
    el('div', { class: 'gauges' }, contextGauge(session.context), progressGauge(session.plan)),
    el('h3', { class: 'side-label' }, 'TASK LIST'),
    planList(session.plan),
    el('h3', { class: 'side-label' }, 'TERMINAL'),
    liveTerminal(session, LIVE_LINES.compact, false),
    el('h3', { class: 'side-label' }, 'AGENTS'),
    agentList(runs),
  )
  return { signature, node }
}

/** A small tag before the folder: where the session runs. */
function sourceTag(source) {
  if (!source) return null
  const icon = svg('svg', { width: 11, height: 11, viewBox: '0 0 16 16', 'aria-hidden': 'true' })
  icon.append(svg('path', { d: SOURCE_ICONS[source.kind], fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
  return el('span', { class: `source source-${source.kind}`, title: source.about }, icon, source.label)
}

function fact(label, value) {
  return el('div', {}, el('dt', {}, label), el('dd', { title: value }, value))
}

function agentChips(runs) {
  if (runs.length === 0) return el('span', { class: 'note' }, 'no agents')
  return L.mapRows(runs)
    .filter(row => row.depth === 0)
    .map(({ run, status, agents, working }) =>
      el(
        'span',
        { class: `chip run-${status}`, title: `${run.label}: ${L.RUN_LABEL[status]}${agents ? ` · ${working} of ${agentCount(agents)} working` : ''}${run.lastAction && !agents ? ` · ${run.lastAction}` : ''}` },
        `${RUN_MARK[status] ?? '•'} ${clip(run.label, 26)}`,
        agents ? el('span', { class: 'time' }, ` ${working}/${agents}`) : null,
        status === 'running' && !agents ? since(run.startedAt, undefined, { class: 'time' }) : null,
      ),
    )
}

/** The session's own log, folded away until the person opens it; it stays open across updates. */
function tileLog(session) {
  const entries = L.recentLog(session)
  if (entries.length === 0) return el('p', { class: 'tile-log-empty' }, 'Log (0)')
  const details = el('details', { class: 'tile-log', open: view.openLogs.has(session.sessionId) })
  details.addEventListener('toggle', () => {
    if (details.open) view.openLogs.add(session.sessionId)
    else view.openLogs.delete(session.sessionId)
  })
  details.append(el('summary', {}, `Log (${entries.length})`), el('div', { class: 'terminal' }, el('ol', { class: 'log' }, entries.map(drawLine))))
  return details
}

function drawLine(entry) {
  return el(
    'li',
    { class: `line status-${entry.status}` },
    el('span', { class: 'time' }, L.clock(entry.at)),
    el('span', { class: 'mark', 'aria-label': entry.status }, LOG_MARK[entry.status] ?? '?'),
    el('span', { class: 'text', title: entry.text }, entry.who ? [el('span', { class: 'who' }, `[${clip(entry.who, 18)}] `), entry.text] : entry.text),
  )
}

// ---------- prompts today and the tool mix ----------

/** The prompts the person wrote today, in the header: from the transcripts, every 15 seconds with the tokens. */
function renderPromptCount(tags) {
  const prompts = view.tokens?.prompts
  if (!prompts) return
  setText('#prompts-total', prompts.total ?? 0)
  document.querySelector('#prompts').setAttribute('title', L.promptSummary(prompts, tags ?? view.tags ?? new Map()))
}

function renderTools(sessions) {
  const mix = L.toolMix(sessions)
  const signature = JSON.stringify(mix)
  if (signature === view.tools) return
  view.tools = signature
  const top = mix[0]?.count ?? 1
  document.querySelector('#tools').replaceChildren(
    ...mix.map(tool =>
      el(
        'div',
        { class: 'tool' },
        el('span', { class: 'name' }, tool.name),
        el('span', { class: 'track', role: 'img', 'aria-label': `${tool.name}: ${tool.count} calls` }, el('span', { class: 'fill', style: `width:${Math.round((tool.count / top) * 100)}%` })),
        el('span', { class: 'count' }, tool.count),
      ),
    ),
  )
  document.querySelector('#tools-empty').hidden = mix.length > 0
}

// ---------- agent map ----------

/** Clears the finished runs from the map and the cards; new runs show as they start. */
function clearFinishedRuns() {
  view.layout = { ...view.layout, runsClearedAt: Date.now() }
  saveLayout(view.layout)
  redrawTiles()
  poll()
}

function renderMap(sessions, tags) {
  const groups = sessions
    .map(session => ({ ...session, runs: L.shownRuns(session.runs, view.layout.runsClearedAt) }))
    .filter(session => session.runs.length > 0)
  const box = document.querySelector('#map')
  // the step boxes after an agent fill the width the map has, so a wider map draws again
  const width = box.clientWidth || 900
  const signature = JSON.stringify([Math.round(width / 40), groups.map(s => [s.sessionId, tags.get(s.sessionId), L.identityColor(view.slots, s.sessionId), s.runs])])
  if (signature === view.map) return
  view.map = signature
  const panel = document.querySelector('[data-panel="map"]')
  // the map shows only while something works, and pops up by itself when an agent starts
  const running = groups.reduce((sum, s) => sum + L.mapRows(s.runs).filter(row => row.status === 'running').length, 0)
  const wasHidden = panel.hidden
  panel.hidden = running === 0
  if (wasHidden && !panel.hidden && view.settings.animations) {
    panel.classList.remove('popping')
    void panel.offsetWidth
    panel.classList.add('popping')
  }
  document.querySelector('#map-empty').hidden = groups.length > 0
  panel.classList.toggle('empty', groups.length === 0)
  setText('#map-count', groups.length ? `· ${running} running` : '')
  if (groups.length === 0) {
    box.replaceChildren()
    box.style.height = '0px'
    return
  }

  const nodes = []
  const edges = svg('svg', { class: 'map-edges', width: MAP.edgeW, 'aria-hidden': 'true' })
  let y = 0
  for (const session of groups) {
    const rows = L.mapRows(session.runs)
    const groupH = rows.length * MAP.rowH - (MAP.rowH - MAP.agentH)
    const sessionTop = y + groupH / 2 - MAP.sessionH / 2
    const fromY = sessionTop + MAP.sessionH / 2
    nodes.push(
      el(
        'div',
        { class: 'map-session', style: `top:${sessionTop}px`, title: tags.get(session.sessionId) },
        el('span', { class: 'dot', style: `background:${L.identityColor(view.slots, session.sessionId)}`, 'aria-hidden': 'true' }),
        el('span', { class: 'text' }, tags.get(session.sessionId)),
      ),
    )
    rows.forEach((row, i) => {
      const top = y + i * MAP.rowH
      nodes.push(agentNode(row, top, session.sessionId, width))
      if (row.depth === 0) drawEdge(edges, fromY, top + MAP.agentH / 2, row.status === 'running', i)
    })
    y += groupH + MAP.groupGap
  }
  const height = y - MAP.groupGap
  edges.setAttribute('height', height)
  edges.setAttribute('viewBox', `0 0 ${MAP.edgeW} ${height}`)
  box.style.height = `${height}px`
  box.setAttribute('role', 'img')
  box.setAttribute('aria-label', groups.map(s => `${tags.get(s.sessionId)}: ${L.mapRows(s.runs).map(r => `${r.run.label} ${L.RUN_LABEL[r.status]}`).join(', ')}`).join('; '))
  // a row that had the keyboard gets it back once the map is drawn again
  const focused = document.activeElement?.closest?.('#map [data-key]')?.dataset.key
  box.replaceChildren(edges, ...nodes)
  if (document.body.classList.contains('away')) edges.pauseAnimations?.()
  if (focused) box.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
}

// the agent's own box in the map, and each small step box after it with the line to it
const STEP_BOX = { agentW: 240, stepW: 128, gap: 14, chip: 58 }

/**
 * One run in the map; a workflow says how many of its agents work, and its agents hang under it.
 * A command in the background says so, since its name is what it does. An agent is a node with
 * its steps as small boxes after it, as a graph: its planned steps when it keeps a task list, else
 * its latest tool calls. A click shows them all.
 */
function agentNode({ run, depth, status, agents, working }, top, sessionId, width) {
  const { count } = L.agentSteps(run)
  const doing = run.lastAction ?? (run.kind === 'command' ? 'background command' : undefined)
  // the chip for earlier steps keeps its place, so the boxes line up row under row
  const room = (width - (depth ? 344 : 300) - STEP_BOX.agentW - STEP_BOX.chip - 4) / (STEP_BOX.stepW + STEP_BOX.gap)
  const graph = agents || run.kind !== 'agent' ? { nodes: [], earlier: 0, later: 0 } : L.stepNodes(run, room)
  const isGraph = graph.nodes.length > 0
  const action = agents ? `${working} of ${agentCount(agents)} working` : isGraph ? `${count} ${count === 1 ? 'step' : 'steps'}` : count && doing ? `#${count} · ${doing}` : doing
  const canOpen = !agents && (count > 0 || L.agentPlan(run).length > 0)
  const box = el(
    'div',
    { class: `map-agent run-${status}` },
    el('span', { class: 'title' }, run.label),
    el(
      'span',
      { class: 'meta' },
      el('span', { class: `run-${status}`, style: 'font-weight:700' }, `${RUN_MARK[status] ?? '•'} ${L.RUN_LABEL[status]}`),
      ' · ',
      since(run.startedAt, run.endedAt),
      action ? [' · ', el('span', { class: 'action' }, action)] : null,
    ),
  )
  const row = el(
    'div',
    {
      class: `map-row${depth ? ' child' : ''}${isGraph ? ' graph' : ''}${canOpen ? ' can-open' : ''} run-${status}`,
      style: `top:${top}px`,
      'data-key': `${sessionId}:${run.id}`,
      title: action ? `${run.label} · ${action}` : run.label,
      ...(canOpen ? { role: 'button', tabindex: '0', 'aria-label': `${run.label}, ${L.RUN_LABEL[status]}, ${count} ${count === 1 ? 'step' : 'steps'}: show them` } : {}),
    },
    box,
    isGraph ? stepGraph(graph, status === 'running') : null,
  )
  if (canOpen) {
    row.addEventListener('click', () => openSteps(sessionId, run.id))
    row.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      openSteps(sessionId, run.id)
    })
  }
  return row
}

/** An agent's steps as small boxes in a line, each joined to the one before; a chip says how many more there are. */
function stepGraph({ nodes, earlier, later }, isWorking) {
  const more = (count, where) => (count > 0 ? el('span', { class: `step-more ${where}`, title: `${count} more ${count === 1 ? 'step' : 'steps'}` }, `+${count}`) : null)
  return el(
    'div',
    { class: 'map-steps', 'aria-hidden': 'true' },
    // the place for the earlier steps' chip is kept when there are none, so the boxes line up
    more(earlier, 'before') ?? el('span', { class: 'step-more before empty' }),
    ...nodes.map(node => {
      const words = node.kind === 'plan' ? { verb: node.text, rest: '' } : L.stepWords(node.text)
      return el(
        'span',
        { class: `step-box step-${node.status}${node.kind === 'plan' ? ' planned' : ''}${isWorking && node.status === 'running' ? ' now' : ''}`, title: `${node.number}. ${node.text}` },
        el('span', { class: 'step-head' }, el('span', { class: 'step-number' }, String(node.number)), el('span', { class: 'step-verb' }, words.verb)),
        words.rest ? el('span', { class: 'step-rest' }, words.rest) : null,
      )
    }),
    more(later, 'after'),
  )
}

// ---------- an agent's steps ----------

const STEP_STATE = { running: 'working', ok: 'done', error: 'failed' }
const AGENT_PLAN_MARK = { completed: '✓', in_progress: '▸', pending: '○' }

/** Clicking an agent in the map opens its steps: each tool call it made, numbered, the latest last. */
function setupAgentSteps() {
  const dialog = document.querySelector('#agent-steps')
  document.querySelector('#as-close').addEventListener('click', () => dialog.close())
  // a click on the dimmed board around the window closes it
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close()
  })
  dialog.addEventListener('close', () => {
    view.stepsOf = null
  })
}

function openSteps(sessionId, runId) {
  view.stepsOf = { sessionId, runId, signature: '' }
  document.querySelector('#agent-steps').showModal()
  drawAgentSteps(true)
}

/** The open window drawn again once the agent took a step; it follows the newest while it is at the bottom. */
function drawAgentSteps(toEnd = false) {
  const open = view.stepsOf
  if (!open || !document.querySelector('#agent-steps').open) return
  const run = view.byId?.get(open.sessionId)?.runs?.find(one => one.id === open.runId)
  const signature = JSON.stringify(run ?? null)
  if (signature === open.signature) return
  open.signature = signature
  const list = document.querySelector('#as-steps')
  const note = document.querySelector('#as-note')
  const wasAtEnd = toEnd || list.scrollHeight - list.scrollTop - list.clientHeight < 24
  // while scrolled up, the step at the top stays where it was though earlier ones drop off the list
  const topOf = item => item.getBoundingClientRect().top - list.getBoundingClientRect().top
  const anchor = wasAtEnd ? null : [...list.children].find(item => topOf(item) + item.offsetHeight > 0)
  const anchorAt = anchor ? { number: anchor.dataset.number, offset: topOf(anchor) } : null
  if (!run) {
    document.querySelector('#as-head').replaceChildren(el('div', { class: 'as-title' }, 'This agent is no longer on the board.'))
    list.replaceChildren()
    note.hidden = true
    return
  }
  const { count, earlier, steps } = L.agentSteps(run)
  const status = run.status
  document.querySelector('#as-head').replaceChildren(
    el('div', { class: 'as-title' }, run.label),
    el(
      'div',
      { class: 'as-meta' },
      el('span', { class: `run-${status}`, style: 'font-weight:700' }, `${RUN_MARK[status] ?? '•'} ${L.RUN_LABEL[status]}`),
      ' · ',
      since(run.startedAt, run.endedAt),
      ` · ${count} ${count === 1 ? 'step' : 'steps'}`,
      view.tags?.get(open.sessionId) ? ` · ${view.tags.get(open.sessionId)}` : '',
    ),
  )
  const plan = L.agentPlan(run)
  const planList = document.querySelector('#as-plan')
  planList.hidden = plan.length === 0
  planList.replaceChildren(
    el('li', { class: 'as-plan-title' }, 'Its plan'),
    ...plan.map((step, i) => el('li', { class: `as-plan-step plan-${step.status}` }, el('span', { class: 'as-number' }, String(i + 1)), el('span', { class: 'as-mark' }, AGENT_PLAN_MARK[step.status] ?? '○'), el('span', { class: 'as-text' }, step.text))),
  )
  note.hidden = earlier === 0
  note.textContent = earlier ? `The first ${earlier} steps are no longer kept; these are the last ${steps.length}.` : ''
  list.replaceChildren(
    ...steps.map(step => {
      // a step the agent never finished stops where the agent did
      const until = step.endedAt ?? (status === 'running' ? undefined : (run.endedAt ?? step.at))
      return el(
        'li',
        { class: `as-step step-${step.status}`, 'data-number': step.number },
        el('span', { class: 'as-number' }, String(step.number)),
        el('span', { class: 'as-mark', title: STEP_STATE[step.status] ?? '' }, LOG_MARK[step.status] ?? '…'),
        el('span', { class: 'as-text', title: step.text }, step.text),
        since(step.at, until, { class: 'as-time' }),
      )
    }),
  )
  const kept = anchorAt ? list.querySelector(`[data-number="${anchorAt.number}"]`) : null
  if (wasAtEnd) list.scrollTop = list.scrollHeight
  else if (kept) list.scrollTop += topOf(kept) - anchorAt.offset
  tickTimers()
}

function drawEdge(edges, fromY, toY, isLive, index) {
  const d = `M0 ${fromY} C${MAP.edgeW / 2} ${fromY} ${MAP.edgeW / 2} ${toY} ${MAP.edgeW} ${toY}`
  edges.append(svg('path', { class: `edge${isLive ? ' live' : ''}`, d }))
  if (!isLive || !view.settings.animations) return
  const bubble = svg('circle', { class: 'edge-bubble', r: 4.5 })
  bubble.append(svg('animateMotion', { dur: `${1.6 + (index % 3) * 0.3}s`, repeatCount: 'indefinite', path: d }))
  edges.append(bubble)
}

// ---------- timers and polling ----------

function tickTimers() {
  const now = Date.now()
  setText('#clock', L.clock(now))
  for (const node of document.querySelectorAll('[data-since]')) {
    const start = Number(node.getAttribute('data-since'))
    const until = node.getAttribute('data-until')
    if (!Number.isFinite(start)) continue
    const text = L.duration((until ? Number(until) : now) - start)
    if (node.textContent !== text) node.textContent = text
  }
}

function setOnline(isOnline) {
  document.body.classList.toggle('offline', !isOnline)
  const link = document.querySelector('#link')
  link.className = `pill ${isOnline ? 'pill-work live' : 'pill-fail'}`
  setText('#link', isOnline ? '● LIVE' : '○ SERVER NOT RESPONDING')
}

function render(sessions, now) {
  for (const session of sessions) {
    if (!view.firstSeen.has(session.sessionId)) view.firstSeen.set(session.sessionId, now)
  }
  const present = new Set([...sessions.map(session => session.sessionId), ...view.terminals.map(card => card.id)])
  for (const id of view.removing) if (!present.has(id)) view.removing.delete(id)
  const visible = L.foldChildren(L.visibleSessions(sessions, now, view.firstSeen, view.removing), view.hidden)
  view.slots = L.assignSlots(view.slots, visible.map(session => session.sessionId))
  const tags = L.sessionTags(visible)
  view.last = sessions
  view.byId = new Map(sessions.map(session => [session.sessionId, session]))
  view.tags = tags
  const day = L.dayOf(now)
  const held = L.holdPeaks(L.currentLimits(sessions, now), view.limitPeaks, now)
  view.limitPeaks = held.peaks
  const everything = [...sessions, ...view.hidden]
  renderOverview(L.summarize(visible, now), held.limits, now)
  renderTiles(visible, now, day, tags)
  renderPromptCount(tags)
  renderTools(visible)
  renderMap(visible, tags)
  drawAgentSteps()
  view.decor.update({
    sessions: visible,
    summary: L.summarize(visible, now),
    limits: held.limits,
    total: L.totalOn(everything, day),
    now,
    tags,
    colorOf: id => L.identityColor(view.slots, id),
  })
  updateChat()
  measureBar()
  tickTimers()
}

/**
 * The board loads its new code by itself once its files change, so it never runs old code without
 * anyone knowing. While the person writes or has a window open, a button in the header waits instead.
 */
function followBoardVersion(version) {
  if (typeof version !== 'string' || !version) return
  view.boardVersion ??= version
  const isNew = version !== view.boardVersion
  const button = document.querySelector('#update-ready')
  button.hidden = !isNew
  if (!isNew) return
  // words not yet sent in a chat or a question box, or a field the person is typing in (the notes save as they go)
  const isWriting =
    [...document.querySelectorAll('.expanded-tile textarea, .q-other')].some(field => field.value.trim() !== '') ||
    Boolean(document.activeElement?.matches?.('textarea, input'))
  const isWindowOpen = Boolean(document.querySelector('dialog[open]'))
  if (L.mayReloadNow({ isWriting, isWindowOpen, isInteracting: Boolean(view.isInteracting) })) location.reload()
}

document.querySelector('#update-ready').addEventListener('click', () => location.reload())

/**
 * The board loads itself again when its files change. The browser would put the page back where it
 * was before the cards are drawn, so it lands at the top: the board keeps the place itself, for this
 * tab, and goes back to it once its cards are on the page.
 */
const PLACE_KEY = 'ccc.boardScroll'

function keepPlaceOverReloads() {
  history.scrollRestoration = 'manual'
  window.addEventListener('pagehide', () => {
    try {
      sessionStorage.setItem(PLACE_KEY, String(Math.round(window.scrollY)))
    } catch {
      // no storage here: the board starts at the top
    }
  })
}

function putPlaceBack() {
  let top = 0
  try {
    top = Number(sessionStorage.getItem(PLACE_KEY)) || 0
    sessionStorage.removeItem(PLACE_KEY)
  } catch {
    return
  }
  if (top > 0) window.scrollTo(0, top)
}

// ---------- caveman mode ----------

function showCaveman(choices) {
  view.caveman = { default: choices.default ?? 'off', sessions: choices.sessions && typeof choices.sessions === 'object' ? choices.sessions : {} }
  const select = document.querySelector('#opt-caveman')
  if (select && document.activeElement !== select) select.value = view.caveman.default
}

/** Switches caveman mode for a session, or the default with no session; true once the server has it. */
async function chooseCaveman(sessionId, level) {
  try {
    const response = await fetch('/api/caveman', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CCC-Action': 'caveman' },
      body: JSON.stringify({ ...(sessionId ? { sessionId } : {}), level }),
    })
    const answer = response.ok ? await response.json() : { ok: false }
    if (answer.caveman) showCaveman(answer.caveman)
    return answer.ok === true
  } catch {
    return false
  }
}

function setupCaveman() {
  const select = document.querySelector('#opt-caveman')
  select?.addEventListener('change', async () => {
    if (!(await chooseCaveman(null, select.value))) select.value = view.caveman.default
    render(view.last ?? [], Date.now())
  })
}

async function poll() {
  try {
    const response = await fetch('/api/sessions', { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const { sessions, hidden, boardVersion, terminals, terminalApps, editorApps, caveman } = await response.json()
    view.hidden = Array.isArray(hidden) ? hidden : []
    view.terminals = Array.isArray(terminals) ? terminals.filter(card => card && typeof card.id === 'string' && typeof card.folder === 'string') : []
    view.terminalApps = Array.isArray(terminalApps) ? terminalApps : []
    view.editorApps = Array.isArray(editorApps) ? editorApps : []
    if (caveman && typeof caveman === 'object') showCaveman(caveman)
    setOnline(true)
    render(Array.isArray(sessions) ? sessions : [], Date.now())
    if (!view.isPlaceBack) {
      view.isPlaceBack = true
      putPlaceBack()
    }
    followBoardVersion(boardVersion)
  } catch {
    setOnline(false)
  }
}


makeBubbles()
applyScale()
// the live feed and the right column stick right under the top bar, however tall it is at this scale
function measureBar() {
  fitSummary()
  const height = `${Math.round(document.querySelector('.taskbar').getBoundingClientRect().height)}px`
  if (document.documentElement.style.getPropertyValue('--bar-top') !== height) document.documentElement.style.setProperty('--bar-top', height)
}
measureBar()
new ResizeObserver(measureBar).observe(document.querySelector('.taskbar'))
window.addEventListener('resize', measureBar)
applySettings(view.settings)
setupSettings(view.settings, { onChange: applySettings, onResetLayout: resetLayout })
setupLayout()
setupNotes()
setupCaveman()
document.querySelector('#map-clear').addEventListener('click', clearFinishedRuns)
setupChat({
  sessionOf: id => view.byId.get(id),
  // the editor a step's file opens in, or null while the setting is off
  editorOf: () => L.editorChoice(view.settings.editor, view.editorApps),
  titleOf: id => view.tags.get(id),
  cavemanOf: id => cavemanOf(view.caveman, id),
  showsNotes: () => view.settings.showNotes,
  setCaveman: (id, level) => chooseCaveman(id, level),
  colorOf: id => L.identityColor(view.slots, id),
  statsOf: id => chatStats(view.byId.get(id), Date.now()),
  onRemove: (id, title) => askToRemove(id, title),
  // the facts panel starts folded away, as every session now opens into its chat; opened, it stays open
  isSideHidden: id => !view.layout.chats?.[id]?.showSide,
  onSide: (id, isHidden) => {
    const { showSide: _was, hideSide: _old, ...size } = view.layout.chats?.[id] ?? {}
    view.layout.chats = { ...view.layout.chats, [id]: isHidden ? size : { ...size, showSide: true } }
    saveLayout(view.layout)
  },
})
setupTerminals({
  appName: () => chosenApp().name,
  appId: () => view.settings.terminalApp,
  themeId: () => view.settings.theme,
  onClose: askToCloseTerminal,
  onRestarted: moveTerminalPlace,
})
// how far under the pinned top bar and live feed a chat's header lands when the board scrolls to it
const SHOW_GAP = 14
// the glide takes longer the further it goes, within these bounds
const GLIDE_MS = { least: 350, most: 900, perPixel: 0.45 }

/**
 * A click on a session's dot on the radar glides the board, up or down alike, until the chat's own
 * header sits just under the top bar and the live feed, and lights the chat up for a moment. The
 * board draws the glide itself, frame by frame: the browser's own smooth scroll does not run in
 * every window, and is cut short by anything else that scrolls. The cursor goes into the chat's
 * write box once the glide is done, without moving the page itself.
 */
window.addEventListener('ccc:show-session', event => {
  const id = event.detail?.sessionId
  const node = view.tiles.get(id)?.node
  if (!node) return
  const pinned = Math.max(...['.taskbar', '#decor-top'].map(selector => document.querySelector(selector)?.getBoundingClientRect().bottom ?? 0))
  const most = document.scrollingElement.scrollHeight - window.innerHeight
  const top = Math.min(most, Math.max(0, window.scrollY + node.getBoundingClientRect().top - pinned - SHOW_GAP))
  node.classList.remove('spotlit')
  void node.offsetWidth
  node.classList.add('spotlit')
  glideTo(top, () => (isTerminal(id) ? focusTerminal(id) : focusChat(id)))
})

/** Scrolls the page to `top` with an ease in and out; a turn of the wheel or a touch stops it there. */
function glideTo(top, done) {
  cancelAnimationFrame(view.glide ?? 0)
  const from = window.scrollY
  const distance = top - from
  if (Math.abs(distance) < 1) return done()
  const duration = Math.min(GLIDE_MS.most, Math.max(GLIDE_MS.least, Math.abs(distance) * GLIDE_MS.perPixel))
  const started = performance.now()
  const stop = () => {
    cancelAnimationFrame(view.glide ?? 0)
    window.removeEventListener('wheel', stop)
    window.removeEventListener('touchstart', stop)
  }
  window.addEventListener('wheel', stop, { passive: true })
  window.addEventListener('touchstart', stop, { passive: true })
  const step = now => {
    const u = Math.min(1, (now - started) / duration)
    const eased = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2
    window.scrollTo(0, from + distance * eased)
    if (u < 1) {
      view.glide = requestAnimationFrame(step)
      return
    }
    stop()
    done()
  }
  view.glide = requestAnimationFrame(step)
}
watchWindowMoves(() => view.wobble)
document.addEventListener('keydown', () => (view.typedAt = Date.now()), true)
keepPlaceOverReloads()
window.addEventListener('resize', applyScale)
setInterval(poll, POLL_MS)
setInterval(tickTimers, 1000)
poll()
setupTokenChart()
setupTokenHistory()
setupAgentSteps()
followFocus()
setupStart()
setupShiftScroll()
pollTokens()
setInterval(pollTokens, TOKENS_POLL_MS)
