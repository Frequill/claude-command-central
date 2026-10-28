// What each theme adds beyond its background: a radar, bars and tickers fed with the board's
// own live data. Clean adds nothing. Every text goes in as textContent.

import * as L from './board-logic.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const DECOR = { aero, inferno, neon, cyberpunk, space, eva, xp, win98, spectrum, clean, 'clean-dark': cleanDark, macos }

/**
 * Mounts the theme's extras, and the status bar along the bottom in the theme's look when the
 * person has it on (`statusBar`); `update(data)` refreshes them, `stop()` takes them away.
 */
export function startDecor(themeId, { statusBar = true } = {}) {
  for (const id of ['#decor-top', '#decor-side', '#decor-bottom']) document.querySelector(id).replaceChildren()
  setText(document.querySelector('#tray-date'), '')
  const make = DECOR[themeId]
  const own = make ? make() : { update() {}, stop() {} }
  const ticker = mountTicker()
  const bar = statusBar ? mountStatusBar(themeId) : { update() {}, stop() {} }
  return {
    update(data) {
      own.update(data)
      ticker.update(data)
      bar.update(data)
    },
    stop() {
      own.stop()
      ticker.stop()
      bar.stop()
    },
  }
}

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (name === 'class') node.className = value
    else if (name === 'style') node.style.cssText = value
    else node.setAttribute(name, String(value))
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child)
  return node
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) if (value !== undefined && value !== null) node.setAttribute(name, String(value))
  if (text !== undefined) node.textContent = text
  return node
}

function setText(node, value) {
  if (node && node.textContent !== String(value)) node.textContent = String(value)
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, Number.isFinite(value) ? value : 0))

function percentOf(limits, kind) {
  const limit = limits.find(one => one.kind === kind)
  return limit ? Math.round(limit.percentUsed) : null
}

/** The fullest context window among sessions that are still live. */
function fullestContext(sessions) {
  const live = sessions.filter(s => s.endedAt === undefined && s.context)
  return live.length ? Math.max(...live.map(s => s.context.percent)) : null
}

// ==========================================================================
// Aero 2007: the date in the tray, under the clock.
// ==========================================================================

function aero() {
  const radar = mountRadar('aero')
  return {
    update(data) {
      const at = new Date(data.now)
      setText(document.querySelector('#tray-date'), at.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'numeric' }))
      radar.update(data)
    },
    stop() {
      radar.stop()
    },
  }
}

// ==========================================================================
// Clean: the radar alone, drawn with thin lines.
// ==========================================================================

function clean() {
  return mountRadar('clean')
}

// Clean Dark: the same quiet radar, in light lines on dark grey.
function cleanDark() {
  return mountRadar('clean-dark')
}

// macOS: the radar, frosted, with a blue sweep.
function macos() {
  return mountRadar('macos')
}

// Windows 98: the radar in grey and navy, its dots square pixels.
function win98() {
  return mountRadar('win98')
}

// ==========================================================================
// Inferno: the radar; its status bar has big red numbers and a skull that grows
// angrier the more of the five-hour limit is used.
// ==========================================================================

function inferno() {
  return mountRadar('inferno')
}

// ==========================================================================
// The status bar along the bottom, on in every theme unless the person turns it
// off in the settings: a vial for
// each limit that fills as it is used, today's spend, the agents at work, and
// the theme's own emblem in the middle, which grows uneasy as the five-hour
// limit runs out. The looks differ in colours and emblem only.
// ==========================================================================

function mountStatusBar(look) {
  const cells = {}
  const cell = (key, label) => {
    cells[key] = { value: el('span', { class: 'hud-value' }, '–'), note: el('span', { class: 'hud-note' }) }
    return el('div', { class: 'hud-cell' }, cells[key].value, el('span', { class: 'hud-label' }, label), cells[key].note)
  }
  // a limit cell: a vial that fills as the limit is used, beside its numbers
  const limitCell = (key, label) => {
    cells[key] = { value: el('span', { class: 'hud-value' }, '–'), note: el('span', { class: 'hud-note' }), vial: lavaVial(key) }
    return el(
      'div',
      { class: 'hud-cell hud-limit' },
      cells[key].vial.node,
      el('div', { class: 'hud-stack' }, cells[key].value, el('span', { class: 'hud-label' }, label), cells[key].note),
    )
  }
  const emblem = (EMBLEMS[look] ?? EMBLEMS.inferno)()
  const bar = el(
    'div',
    { class: `doom-bar status-bar status-${look}`, role: 'status', 'aria-label': 'Status bar' },
    limitCell('five', '5H'),
    limitCell('week', 'WEEK'),
    el('div', { class: 'hud-face' }, emblem.node),
    cell('spent', 'SPENT'),
    cell('agents', 'AGENTS'),
  )
  document.querySelector('#decor-bottom').append(bar)
  document.body.classList.add('has-status-bar')
  const showLimit = (key, limit, now) => {
    setText(cells[key].value, limit ? `${Math.round(limit.percentUsed)}%` : '–')
    const reset = limit?.resetsAt ? resetText(limit.resetsAt, now) : ''
    setText(cells[key].note, limit ? (reset ? `resets ${reset}` : '') : 'no reading yet')
    cells[key].vial.fill(limit ? limit.percentUsed : 0)
  }
  return {
    update({ summary, limits, total, now }) {
      showLimit('five', limits.find(one => one.kind === 'five_hour'), now)
      showLimit('week', limits.find(one => one.kind === 'seven_day'), now)
      setText(cells.spent.value, `$${total.toFixed(2)}`)
      setText(cells.spent.note, 'today')
      setText(cells.agents.value, summary.agentsRunning)
      setText(cells.agents.note, 'running')
      emblem.mood(percentOf(limits, 'five_hour') ?? 0)
    },
    stop() {
      bar.remove()
      document.body.classList.remove('has-status-bar')
    },
  }
}

/** How uneasy an emblem looks at this share of the five-hour limit used. */
function moodOf(fivePercent) {
  return fivePercent >= 80 ? 'furious' : fivePercent >= 50 ? 'angry' : 'calm'
}

/** An emblem that only shows the mood (its CSS does the rest). */
function emblemOf(node) {
  return {
    node,
    mood(fivePercent) {
      node.dataset.mood = moodOf(fivePercent)
    },
  }
}

// each theme's emblem in the middle of the bar
const EMBLEMS = {
  inferno: () => skullFace(),
  // the Evangelion title, flashing like an alert as the limit runs out
  eva: () => emblemOf(el('img', { class: 'emblem emblem-eva', src: '/eva-logo.png', alt: 'Evangelion' })),
  // a neon ring, like a sign over the street
  neon: () => {
    const node = svg('svg', { viewBox: '0 0 64 64', class: 'emblem emblem-neon', role: 'img', 'aria-label': 'Neon ring' })
    node.append(svg('circle', { cx: 32, cy: 32, r: 24, class: 'ring-outer' }), svg('circle', { cx: 32, cy: 32, r: 15, class: 'ring-inner' }), svg('circle', { cx: 32, cy: 32, r: 4, class: 'ring-core' }))
    return emblemOf(node)
  },
  // a ringed planet
  space: () => {
    const node = svg('svg', { viewBox: '0 0 64 64', class: 'emblem emblem-space', role: 'img', 'aria-label': 'Planet' })
    node.append(
      svg('ellipse', { cx: 32, cy: 33, rx: 29, ry: 8, class: 'planet-ring back' }),
      svg('circle', { cx: 32, cy: 32, r: 17, class: 'planet-body' }),
      svg('path', { d: 'M3 33 A29 8 0 0 0 61 33', class: 'planet-ring' }),
    )
    return emblemOf(node)
  },
  // Windows XP: the four-colour flag on its own, waving a little as on the boot screen. Each pane's
  // top and bottom edges are gentle waves, with a gloss across its top half
  xp: () => {
    const flag = svg('svg', { viewBox: '0 0 44 40', class: 'emblem emblem-xp', role: 'img', 'aria-label': 'Windows XP' })
    const shine = svg('linearGradient', { id: 'xp-flag-gloss', x1: 0, y1: 0, x2: 0, y2: 1 })
    shine.append(svg('stop', { offset: 0, 'stop-color': '#ffffff', 'stop-opacity': 0.55 }), svg('stop', { offset: 0.5, 'stop-color': '#ffffff', 'stop-opacity': 0 }))
    const defs = svg('defs')
    defs.append(shine)
    flag.append(defs)
    const pane = (x, y) => `M${x} ${y} Q${x + 5} ${y - 2.4} ${x + 10} ${y} T${x + 20} ${y} V${y + 17} Q${x + 15} ${y + 19.4} ${x + 10} ${y + 17} T${x} ${y + 17} Z`
    for (const [x, y, colour] of [[2, 3, '#f65314'], [23, 3, '#7cbb00'], [2, 21, '#00a1f1'], [23, 21, '#ffbb00']]) {
      flag.append(svg('path', { d: pane(x, y), fill: colour }), svg('path', { d: pane(x, y), class: 'xp-flag-gloss' }))
    }
    return emblemOf(flag)
  },
  // ZX Spectrum: its name beside the rainbow, as on the case
  spectrum: () => emblemOf(el('span', { class: 'emblem emblem-spectrum', role: 'img', 'aria-label': 'ZX Spectrum' }, el('span', { class: 'zx-name' }, 'ZX Spectrum'), el('span', { class: 'zx-rainbow', 'aria-hidden': 'true' }))),
  // Clean: three plain dots, nothing more
  clean: () => {
    const node = svg('svg', { viewBox: '0 0 64 64', class: 'emblem emblem-clean', role: 'img', 'aria-label': 'CCC' })
    for (const x of [18, 32, 46]) node.append(svg('circle', { cx: x, cy: 32, r: 6 }))
    return emblemOf(node)
  },
  'clean-dark': () => EMBLEMS.clean(),
  // Cyberpunk 2077: the game's logo, in yellow and cyan as on its title screen, glitching as the limit runs out
  cyberpunk: () => emblemOf(el('span', { class: 'emblem emblem-cyberpunk', role: 'img', 'aria-label': 'Cyberpunk 2077' })),
  // macOS: the Command key on an app icon, as it sits in the Dock
  macos: () => {
    const node = svg('svg', { viewBox: '0 0 64 64', class: 'emblem emblem-macos', role: 'img', 'aria-label': 'Command key' })
    node.append(svg('rect', { x: 4, y: 4, width: 56, height: 56, rx: 14, class: 'mac-icon' }), svg('text', { x: 32, y: 44, 'text-anchor': 'middle', class: 'mac-key' }, '⌘'))
    return emblemOf(node)
  },
  // Windows 98: the My Computer icon, a beige monitor on its stand, in square pixels
  win98: () => {
    const node = svg('svg', { viewBox: '0 0 32 28', class: 'emblem emblem-win98', role: 'img', 'aria-label': 'My Computer', 'shape-rendering': 'crispEdges' })
    node.append(
      svg('rect', { x: 4, y: 1, width: 24, height: 19, class: 'w98-case' }),
      svg('rect', { x: 7, y: 4, width: 18, height: 13, class: 'w98-screen' }),
      svg('rect', { x: 8, y: 5, width: 7, height: 2, class: 'w98-glint' }),
      svg('rect', { x: 12, y: 20, width: 8, height: 3, class: 'w98-case' }),
      svg('rect', { x: 7, y: 23, width: 18, height: 3, class: 'w98-case' }),
      svg('rect', { x: 22, y: 18, width: 3, height: 1, class: 'w98-light' }),
    )
    return emblemOf(node)
  },
  // a soap bubble with its shine
  aero: () => {
    const node = svg('svg', { viewBox: '0 0 64 64', class: 'emblem emblem-aero', role: 'img', 'aria-label': 'Bubble' })
    node.append(svg('circle', { cx: 32, cy: 32, r: 25, class: 'bubble-body' }), svg('ellipse', { cx: 24, cy: 22, rx: 9, ry: 5, class: 'bubble-shine', transform: 'rotate(-30 24 22)' }))
    return emblemOf(node)
  },
}

const LAVA_HOT = 80

/**
 * A glass vial on a stand that fills with lava from the bottom, as far as the limit is used: a
 * glowing surface that wobbles, bubbles rising through what is filled, and marks at each quarter.
 */
function lavaVial(key) {
  const top = 6
  const depth = 76
  const lava = `lava-${key}`
  const inside = `vial-${key}`
  const level = svg('g', { class: 'vial-level' })
  level.append(
    svg('rect', { class: 'vial-lava', x: 4, y: 0, width: 24, height: depth + 4, fill: `url(#${lava})` }),
    svg('path', { class: 'vial-surface', d: 'M4 1 Q10 -2 16 1 T28 1 V4 H4 Z' }),
    ...[8, 17, 23].map((x, i) => svg('circle', { class: `vial-bubble b${i}`, cx: x, cy: depth - 4, r: 1.6 + (i % 2) })),
  )
  const node = svg('svg', { class: 'lava-vial', viewBox: '0 0 32 92', width: 32, height: 92, 'aria-hidden': 'true' })
  const defs = svg('defs')
  const gradient = svg('linearGradient', { id: lava, x1: 0, y1: 0, x2: 0, y2: 1 })
  // the liquid's colours come from the theme (board.css, --liquid-top, --liquid-mid, --liquid-low)
  gradient.append(svg('stop', { offset: 0, class: 'liquid-top' }), svg('stop', { offset: 0.25, class: 'liquid-mid' }), svg('stop', { offset: 1, class: 'liquid-low' }))
  const clip = svg('clipPath', { id: inside })
  clip.append(svg('rect', { x: 6, y: top, width: 20, height: depth, rx: 8 }))
  defs.append(gradient, clip)
  const filled = svg('g', { 'clip-path': `url(#${inside})` })
  filled.append(svg('rect', { class: 'vial-glass', x: 6, y: top, width: 20, height: depth, rx: 8 }), level)
  node.append(
    defs,
    filled,
    ...[0.25, 0.5, 0.75].map(mark => svg('line', { class: 'vial-mark', x1: 6, x2: 11, y1: top + depth * (1 - mark), y2: top + depth * (1 - mark) })),
    svg('rect', { class: 'vial-rim', x: 6, y: top, width: 20, height: depth, rx: 8 }),
    svg('rect', { class: 'vial-cap', x: 4, y: 1, width: 24, height: 6, rx: 2 }),
    svg('rect', { class: 'vial-stand', x: 2, y: top + depth, width: 28, height: 8, rx: 2 }),
  )
  return {
    node,
    fill(percent) {
      const share = clamp(percent, 0, 100) / 100
      level.style.transform = `translateY(${(top + depth * (1 - share)).toFixed(1)}px)`
      node.classList.toggle('hot', percent >= LAVA_HOT)
      node.classList.toggle('empty', share <= 0)
    },
  }
}

/** When a limit resets: the time within a day, else the weekday and time. */
function resetText(resetsAt, now) {
  const at = new Date(resetsAt)
  if (Number.isNaN(at.getTime())) return ''
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return at.getTime() - now < 24 * 3_600_000 ? time : `${at.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`
}

function skullFace() {
  const node = svg('svg', { viewBox: '0 0 64 64', class: 'skull', role: 'img', 'aria-label': 'Skull' })
  node.append(svg('path', { class: 'skull-head', d: 'M32 4C17 4 8 14 8 27c0 8 4 13 8 16v9c0 3 2 5 5 5h22c3 0 5-2 5-5v-9c4-3 8-8 8-16C56 14 47 4 32 4z' }))
  const left = svg('path', { class: 'skull-eye' })
  const right = svg('path', { class: 'skull-eye' })
  node.append(left, right)
  node.append(svg('path', { class: 'skull-nose', d: 'M32 34l-4 7h8z' }))
  for (const x of [24, 29, 34, 39]) node.append(svg('rect', { class: 'skull-tooth', x: x - 1.5, y: 47, width: 3, height: 7, rx: 1 }))
  const crack = svg('path', { class: 'skull-crack', d: 'M36 6l-3 7 4 4-3 6' })
  node.append(crack)
  return {
    node,
    mood(fivePercent) {
      const level = fivePercent >= 80 ? 'furious' : fivePercent >= 50 ? 'angry' : 'calm'
      node.dataset.mood = level
      const tilt = level === 'calm' ? 0 : level === 'angry' ? 3 : 6
      left.setAttribute('d', `M16 ${24 + tilt}c0-5 4-8 9-8s7 3 7 ${7 - tilt}c0 5-4 8-8 8s-8-2-8-7z`)
      right.setAttribute('d', `M48 ${24 + tilt}c0-5-4-8-9-8s-7 3-7 ${7 - tilt}c0 5 4 8 8 8s8-2 8-7z`)
    },
  }
}

// ==========================================================================
// Neon City: a ticker under the top bar, the latest log lines of every
// session running past like a stock feed.
// ==========================================================================

function neon() {
  return mountRadar('neon')
}

// ==========================================================================
// The live feed every theme has under its top bar: the latest log lines of
// every session running past like a stock ticker, one row.
// ==========================================================================

function mountTicker() {
  const track = el('div', { class: 'ticker-track' })
  const ticker = el('div', { class: 'ticker', role: 'marquee', 'aria-label': 'Latest activity' }, el('span', { class: 'ticker-tag' }, 'LIVE FEED'), el('div', { class: 'ticker-window' }, track))
  document.querySelector('#decor-top').append(ticker)
  let signature = ''
  return {
    update({ sessions, tags }) {
      const lines = sessions
        .flatMap(s => (s.log ?? []).map(entry => ({ at: entry.at, tag: tags.get(s.sessionId) ?? s.folder, text: entry.text, status: entry.status })))
        .sort((a, b) => b.at - a.at)
        .slice(0, 16)
      const next = JSON.stringify(lines.map(line => [line.tag, line.text, line.status]))
      if (next === signature) return
      signature = next
      const items = lines.length ? lines : [{ tag: 'CCC', text: 'waiting for the first log line', status: 'ok' }]
      const run = () => items.map(line => el('span', { class: `ticker-item status-${line.status}` }, el('b', {}, line.tag), ` ▸ ${line.text}`))
      track.replaceChildren(...run(), ...run())
      track.style.animationDuration = `${Math.max(30, items.length * 7)}s`
    },
    stop() {
      ticker.remove()
    },
  }
}

// ==========================================================================
// Deep Space: mission control, with a radar of sessions and their agents.
// (Its mission clock is gone: counting from the day's first session, it mostly
// showed the time of day again, right beside the clock.)
// ==========================================================================

function space() {
  return mountRadar('space')
}

// ==========================================================================
// Evangelion: a scope ringed with hexes. (Its active-time clock is gone:
// counting from the day's first session, it mostly showed the time of day
// again, right beside the clock.)
// ==========================================================================

function eva() {
  return mountRadar('eva')
}

// ==========================================================================
// Windows XP: the radar, in Luna's blue and green.
// ==========================================================================

function xp() {
  return mountRadar('xp')
}

// ==========================================================================
// ZX Spectrum: the radar, its dots square pixels in the eight bright colours.
// ==========================================================================

function spectrum() {
  return mountRadar('spectrum')
}

// ==========================================================================
// Cyberpunk 2077: the radar as the HUD's minimap.
// ==========================================================================

function cyberpunk() {
  return mountRadar('cyberpunk')
}

// ==========================================================================
// The radar every theme has, each in its own look: one blip per live session,
// further out the fuller its context is, its working agents in orbit around
// it, and a sweep going round. The looks differ in drawing only.
// ==========================================================================

const SIZE = 220
const MIDDLE = SIZE / 2
const RADAR_LOOKS = {
  space: { backdrop: [], sweep: { slices: 1, width: 45, line: false }, blip: 'dot' },
  aero: { backdrop: ['disc', 'gloss', 'dashes'], sweep: { slices: 6, width: 48, line: false }, blip: 'bubble' },
  inferno: { backdrop: ['disc', 'runes'], sweep: { slices: 6, width: 54, line: true }, blip: 'ember' },
  neon: { backdrop: ['disc', 'spokes', 'dashes'], sweep: { slices: 5, width: 40, line: true }, blip: 'diamond' },
  eva: { backdrop: ['disc', 'hexes', 'dashes'], sweep: { slices: 6, width: 46, line: true }, blip: 'hex' },
  xp: { backdrop: ['disc', 'gloss'], sweep: { slices: 4, width: 44, line: true }, blip: 'bubble' },
  spectrum: { backdrop: ['disc'], sweep: { slices: 4, width: 40, line: true }, blip: 'pixel' },
  clean: { backdrop: [], sweep: { slices: 4, width: 32, line: true }, blip: 'dot' },
  'clean-dark': { backdrop: [], sweep: { slices: 4, width: 32, line: true }, blip: 'dot' },
  macos: { backdrop: ['disc', 'gloss'], sweep: { slices: 4, width: 40, line: true }, blip: 'bubble' },
  win98: { backdrop: ['disc'], sweep: { slices: 4, width: 36, line: true }, blip: 'pixel' },
  cyberpunk: { backdrop: ['disc', 'streets', 'compass', 'player'], sweep: { slices: 3, width: 26, line: true }, blip: 'diamond' },
}

// where each session sits round the radar, kept across theme changes so a dot stays where it was
let radarPlaces = new Map()

function mountRadar(look) {
  const style = RADAR_LOOKS[look] ?? RADAR_LOOKS.clean
  const radar = svg('svg', { class: `radar radar-${look}`, viewBox: `0 0 ${SIZE} ${SIZE}`, role: 'img', 'aria-label': 'Radar of sessions' })
  for (const part of style.backdrop) radar.append(BACKDROPS[part](look))
  radar.append(nearlyFullEdge())
  for (const r of [30, 60, 90]) radar.append(svg('circle', { cx: MIDDLE, cy: MIDDLE, r, class: 'radar-ring' }))
  radar.append(svg('line', { x1: MIDDLE, y1: 15, x2: MIDDLE, y2: SIZE - 15, class: 'radar-ring' }))
  radar.append(svg('line', { x1: 15, y1: MIDDLE, x2: SIZE - 15, y2: MIDDLE, class: 'radar-ring' }))
  radar.append(sweep(style.sweep))
  const blips = svg('g')
  radar.append(blips)
  const alert = el('span', { class: 'radar-alert' })
  const box = el(
    'div',
    { class: `glass gadget radar-box radar-box-${look}` },
    el('span', { class: 'gadget-title' }, 'CONTEXT RADAR', alert),
    radar,
    el('span', { class: 'radar-note' }, 'Further out means a fuller context; the shaded edge is nearly full. Hover a dot for its details, click it to go to its chat.'),
  )
  const tip = el('div', { class: 'radar-tip', role: 'tooltip' })
  tip.hidden = true
  box.append(tip)
  document.querySelector('#decor-side').append(box)
  let signature = ''
  let lastStates = new Map()
  // the newest of each session, so a hover shows what is true now, not when its dot was drawn
  const latest = new Map()
  let names = new Map()
  let hovered = ''
  const showTip = (group, sessionId) => {
    const session = latest.get(sessionId)
    if (!session) return
    hovered = sessionId
    tip.replaceChildren(...tipLines(session, names.get(sessionId)))
    tip.hidden = false
    const dot = group.getBoundingClientRect()
    const frame = box.getBoundingClientRect()
    const half = tip.offsetWidth / 2
    const left = Math.min(Math.max(dot.left - frame.left + dot.width / 2, half + 6), frame.width - half - 6)
    tip.style.left = `${left}px`
    // over the dot when there is room under the top bar and its live feed, else under it
    const barBottom = document.querySelector('#decor-top')?.getBoundingClientRect().bottom ?? 0
    const isBelow = dot.top - tip.offsetHeight - 14 < barBottom
    tip.classList.toggle('below', isBelow)
    tip.style.top = `${(isBelow ? dot.bottom : dot.top) - frame.top}px`
  }
  const hideTip = () => {
    hovered = ''
    tip.hidden = true
  }
  return {
    update({ sessions, colorOf, tags, now = Date.now() }) {
      const live = sessions.filter(s => s.endedAt === undefined)
      for (const s of live) latest.set(s.sessionId, s)
      names = tags
      const states = new Map(live.map(s => [s.sessionId, L.sessionState(s, now)]))
      const before = lastStates
      lastStates = states
      radarPlaces = L.radarAngles(radarPlaces, live.map(s => s.sessionId))
      // the sweep turns only while some session works: a still radar means nothing is going on
      radar.classList.toggle('is-still', ![...states.values()].includes('working'))
      setText(alert, L.waitingCount([...states.values()]))
      const next = JSON.stringify(live.map(s => [s.sessionId, s.context?.percent, states.get(s.sessionId), radarPlaces.get(s.sessionId), (s.runs ?? []).filter(r => r.status === 'running').length, colorOf(s.sessionId), tags.get(s.sessionId)]))
      if (hovered && latest.has(hovered)) tip.replaceChildren(...tipLines(latest.get(hovered), tags.get(hovered)))
      if (next === signature) return
      signature = next
      hideTip()
      // sessions that wait for the person are drawn last, so nothing covers them
      const inOrder = [...live].sort((a, b) => (states.get(a.sessionId) === 'needs-you') - (states.get(b.sessionId) === 'needs-you'))
      blips.replaceChildren(
        ...inOrder.map(s => {
          const state = states.get(s.sessionId)
          const group = blip(style.blip, s, {
            angle: radarPlaces.get(s.sessionId),
            state,
            hasFinished: before.get(s.sessionId) === 'working' && state === 'done',
            color: colorOf(s.sessionId),
            label: tags.get(s.sessionId),
          })
          group.addEventListener('pointerenter', () => showTip(group, s.sessionId))
          group.addEventListener('pointerleave', hideTip)
          // a click takes the person to the session's chat on the board
          group.addEventListener('click', () => window.dispatchEvent(new CustomEvent('ccc:show-session', { detail: { sessionId: s.sessionId } })))
          return group
        }),
      )
    },
    stop() {
      box.remove()
    },
  }
}


/** What hovering a session's dot tells: its name and place, what it does, its context, model and agents. */
function tipLines(session, name) {
  const now = Date.now()
  const state = L.sessionState(session, now)
  const activity = L.activityOf(session, now)
  const context = session.context
  const agents = (session.runs ?? []).filter(run => run.status === 'running').length
  const model = [L.modelName(session.stats?.model), session.stats?.effort].filter(Boolean).join(' · ')
  const fill = context ? `${context.percent}% full · ${tokens(context.tokens)} of ${tokens(context.window)}` : 'not measured yet'
  return [
    el('strong', { class: 'tip-name' }, name || session.title || session.folder || 'Session'),
    el('span', { class: 'tip-where' }, [session.folder, session.branch].filter(Boolean).join(' · ')),
    el('span', { class: `tip-state tip-${state}` }, [L.STATE_LABEL[state] ?? state, activity?.text].filter(Boolean).join(' · ')),
    el('span', {}, el('b', {}, 'Context '), fill),
    model ? el('span', {}, el('b', {}, 'Model '), model) : null,
    el('span', {}, el('b', {}, 'Agents '), agents ? `${agents} working` : 'none working'),
  ].filter(Boolean)
}

/** A token count the short way: 68.6k, 1M. */
function tokens(count) {
  if (!Number.isFinite(count)) return '–'
  if (count >= 1_000_000) return `${+(count / 1_000_000).toFixed(1)}M`
  if (count >= 1000) return `${+(count / 1000).toFixed(1)}k`
  return String(count)
}

/** A point on a circle round the middle, `degrees` clockwise from twelve o'clock. */
function pointAt(degrees, radius) {
  const angle = (degrees * Math.PI) / 180
  return [MIDDLE + radius * Math.sin(angle), MIDDLE - radius * Math.cos(angle)]
}

function wedge(from, to, radius) {
  const [x1, y1] = pointAt(from, radius)
  const [x2, y2] = pointAt(to, radius)
  return `M${MIDDLE} ${MIDDLE} L${x1.toFixed(1)} ${y1.toFixed(1)} A${radius} ${radius} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z`
}

/** The sweep: slices that fade towards its tail, and a bright leading edge in some looks. */
function sweep({ slices, width, line }) {
  const group = svg('g', { class: 'radar-sweep' })
  const step = width / slices
  for (let i = 0; i < slices; i += 1) {
    const opacity = slices === 1 ? 1 : ((i + 1) / slices) ** 1.6
    group.append(svg('path', { class: 'sweep-slice', d: wedge(i * step, (i + 1) * step + 0.4, 92), 'fill-opacity': opacity.toFixed(2) }))
  }
  if (line) {
    const [x, y] = pointAt(width, 92)
    group.append(svg('line', { class: 'sweep-edge', x1: MIDDLE, y1: MIDDLE, x2: x.toFixed(1), y2: y.toFixed(1) }))
  }
  return group
}

const BACKDROPS = {
  /** The face of the scope, filled by the look's own colours. */
  disc: look => {
    const gradient = svg('radialGradient', { id: `radar-face-${look}`, cx: '50%', cy: '42%', r: '60%' })
    gradient.append(svg('stop', { offset: '0', class: 'face-from' }), svg('stop', { offset: '1', class: 'face-to' }))
    const defs = svg('defs')
    defs.append(gradient)
    const group = svg('g')
    group.append(defs, svg('circle', { cx: MIDDLE, cy: MIDDLE, r: 100, class: 'radar-face', fill: `url(#radar-face-${look})` }))
    return group
  },
  /** Aero's glass: a soft light across the top of the sphere. */
  gloss: () => svg('ellipse', { cx: MIDDLE, cy: MIDDLE - 52, rx: 70, ry: 34, class: 'radar-gloss' }),
  /** A dashed outer ring turning slowly the other way. */
  dashes: () => svg('circle', { cx: MIDDLE, cy: MIDDLE, r: 100, class: 'radar-dashes' }),
  /** Inferno's ring of runes, turning slowly. */
  runes: () => {
    const group = svg('g', { class: 'radar-runes' })
    group.append(svg('circle', { cx: MIDDLE, cy: MIDDLE, r: 102, class: 'rune-ring' }))
    for (let i = 0; i < 24; i += 1) {
      const [x1, y1] = pointAt(i * 15, i % 3 === 0 ? 92 : 96)
      const [x2, y2] = pointAt(i * 15, 102)
      group.append(svg('line', { x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1), class: 'rune-mark' }))
    }
    for (let i = 0; i < 6; i += 1) {
      const [x, y] = pointAt(i * 60 + 30, 97)
      group.append(svg('path', { d: `M${(x - 3).toFixed(1)} ${(y + 3).toFixed(1)} L${x.toFixed(1)} ${(y - 4).toFixed(1)} L${(x + 3).toFixed(1)} ${(y + 3).toFixed(1)}`, class: 'rune-glyph' }))
    }
    return group
  },
  /** Evangelion's ring of hexes round the edge of the scope. */
  hexes: () => {
    const group = svg('g', { class: 'radar-hexes' })
    for (let i = 0; i < 18; i += 1) {
      const [x, y] = pointAt(i * 20, 96)
      group.append(svg('path', { d: hexPath(x, y, 5.5), class: i % 6 === 0 ? 'hex-mark lit' : 'hex-mark' }))
    }
    return group
  },
  /** Cyberpunk's minimap: a street grid at an angle and a highway sweeping across, inside the scope. */
  streets: look => {
    const clip = svg('clipPath', { id: `radar-clip-${look}` })
    clip.append(svg('circle', { cx: MIDDLE, cy: MIDDLE, r: 98 }))
    const defs = svg('defs')
    defs.append(clip)
    const map = svg('g', { class: 'radar-streets', 'clip-path': `url(#radar-clip-${look})` })
    const grid = svg('g', { transform: `rotate(-24 ${MIDDLE} ${MIDDLE})` })
    // the same streets every time, so the map does not change as the radar redraws
    for (const [at, isMain] of [[14, 0], [31, 1], [44, 0], [63, 0], [79, 1], [92, 0], [108, 0], [121, 1], [139, 0], [152, 0], [170, 1], [186, 0], [199, 0]]) {
      grid.append(svg('line', { x1: -40, y1: at, x2: SIZE + 40, y2: at, class: isMain ? 'street main' : 'street' }))
    }
    for (const [at, isMain] of [[9, 0], [27, 0], [48, 1], [60, 0], [77, 0], [98, 1], [112, 0], [131, 0], [147, 1], [158, 0], [176, 0], [194, 1], [208, 0]]) {
      grid.append(svg('line', { x1: at, y1: -40, x2: at, y2: SIZE + 40, class: isMain ? 'street main' : 'street' }))
    }
    // a few blocks filled in, as buildings on the map
    for (const [x, y, width, height] of [[50, 33, 9, 10], [100, 81, 11, 9], [134, 124, 12, 13], [62, 110, 13, 9], [150, 46, 10, 12]]) {
      grid.append(svg('rect', { x, y, width, height, class: 'block' }))
    }
    grid.append(svg('path', { d: 'M-30 150 C 60 118, 120 172, 250 88', class: 'street highway' }))
    map.append(grid)
    const group = svg('g')
    group.append(defs, map)
    return group
  },
  /** A compass rim: a tick every five degrees, longer at the four points, and N at the top. */
  compass: () => {
    const group = svg('g', { class: 'radar-compass' })
    for (let i = 0; i < 72; i += 1) {
      const isPoint = i % 18 === 0
      const [x1, y1] = pointAt(i * 5, isPoint ? 91 : 96)
      const [x2, y2] = pointAt(i * 5, 100)
      group.append(svg('line', { x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1), class: isPoint ? 'tick point' : 'tick' }))
    }
    group.append(svg('text', { x: MIDDLE, y: 23, 'text-anchor': 'middle', class: 'compass-north' }, 'N'))
    return group
  },
  /** The person on the map: an arrow in the middle, pointing up. */
  player: () => svg('path', { d: `M${MIDDLE} ${MIDDLE - 8} L${MIDDLE + 6} ${MIDDLE + 6} L${MIDDLE} ${MIDDLE + 2} L${MIDDLE - 6} ${MIDDLE + 6} Z`, class: 'radar-player' }),
  /** Neon's six spokes, a scope's grid. */
  spokes: () => {
    const group = svg('g', { class: 'radar-spokes' })
    for (let i = 0; i < 6; i += 1) {
      const [x, y] = pointAt(i * 60 + 30, 100)
      group.append(svg('line', { x1: MIDDLE, y1: MIDDLE, x2: x.toFixed(1), y2: y.toFixed(1) }))
    }
    return group
  },
}

// a session past this much of its context is nearly full: its dot sits in the radar's shaded edge
const NEARLY_FULL = 80

/** How far from the middle a session's dot sits: further out the fuller its context. */
const distanceFor = percent => 22 + clamp(percent ?? 10, 0, 100) * 0.7

/** The shaded edge of the radar, where sessions whose context is nearly full sit. */
function nearlyFullEdge() {
  const inner = distanceFor(NEARLY_FULL) - 2
  const outer = distanceFor(100) + 6
  const ring = r => `M${MIDDLE - r} ${MIDDLE} a${r} ${r} 0 1 0 ${r * 2} 0 a${r} ${r} 0 1 0 ${-r * 2} 0 Z`
  return svg('path', { d: `${ring(outer)} ${ring(inner)}`, class: 'radar-full', 'fill-rule': 'evenodd' })
}

/**
 * A session's dot. Its fill is the session's own colour, the same as its card; the ring round it and
 * how it moves say what it does: a ring pulsing out while it works, a blinking ring and a "!" while
 * it waits for the person, nothing while it is done (one ping as it finishes), hollow when it stopped
 * answering. Every theme draws these the same way, in its own shapes.
 */
function blip(shape, session, { angle, state, hasFinished, color, label }) {
  const [x, y] = pointAt(angle, distanceFor(session.context?.percent))
  const said = (L.STATE_LABEL[state] ?? state).toLowerCase()
  const group = svg('g', {
    class: `blip blip-${shape} is-${state}${hasFinished ? ' has-finished' : ''}`,
    style: `color:${color}`,
    role: 'button',
    'aria-label': `${label ?? session.folder}: ${said}, context ${session.context?.percent ?? '–'}%. Go to its chat.`,
  })
  // a wider, unseen circle, so the small dot is easy to hover and click
  group.append(svg('circle', { cx: x, cy: y, r: 14, class: 'blip-hit' }))
  group.append(...BLIPS[shape](x, y, color))
  if (hasFinished) group.append(svg('circle', { cx: x, cy: y, r: 7, class: 'blip-ping' }))
  const agents = (session.runs ?? []).filter(run => run.status === 'running')
  agents.forEach((_, i) => {
    const orbit = svg('g', { class: 'orbit', style: `transform-origin:${x}px ${y}px;animation-delay:${-i * 0.8}s` })
    orbit.append(svg('circle', { cx: x + 13 + i * 4, cy: y, r: 2.2, class: 'satellite' }))
    group.append(orbit)
  })
  if (state === 'needs-you') {
    const badge = svg('g', { class: 'blip-badge' })
    badge.append(svg('circle', { cx: x + 8, cy: y - 8, r: 5 }), svg('text', { x: x + 8, y: y - 5.2, 'text-anchor': 'middle' }, '!'))
    group.append(badge)
  }
  return group
}

// the halo takes the state's colour from the stylesheet; the core is the session's own colour
const BLIPS = {
  dot: (x, y, color) => [svg('circle', { cx: x, cy: y, r: 9, class: 'blip-halo' }), svg('circle', { cx: x, cy: y, r: 4.5, fill: color, class: 'blip-core' })],
  bubble: (x, y, color) => [
    svg('circle', { cx: x, cy: y, r: 10, class: 'blip-halo' }),
    svg('circle', { cx: x, cy: y, r: 6.5, fill: color, class: 'blip-core' }),
    svg('ellipse', { cx: x - 2, cy: y - 2.6, rx: 3, ry: 1.8, class: 'bubble-shine' }),
  ],
  ember: (x, y, color) => [svg('circle', { cx: x, cy: y, r: 11, class: 'blip-halo' }), svg('circle', { cx: x, cy: y, r: 5, fill: color, class: 'blip-core' })],
  hex: (x, y, color) => [svg('path', { d: hexPath(x, y, 11), class: 'blip-halo hex-halo' }), svg('path', { d: hexPath(x, y, 5.5), fill: color, class: 'blip-core' })],
  pixel: (x, y, color) => [
    svg('rect', { x: x - 10, y: y - 10, width: 20, height: 20, class: 'blip-halo' }),
    svg('rect', { x: x - 5, y: y - 5, width: 10, height: 10, fill: color, class: 'blip-core' }),
  ],
  diamond: (x, y, color) => [svg('path', { d: diamondPath(x, y, 11), class: 'blip-halo diamond-halo' }), svg('path', { d: diamondPath(x, y, 5.5), fill: color, class: 'blip-core' })],
}

function hexPath(x, y, reach) {
  const corners = [0, 1, 2, 3, 4, 5].map(i => `${(x + reach * Math.cos((i * Math.PI) / 3)).toFixed(1)} ${(y + reach * Math.sin((i * Math.PI) / 3)).toFixed(1)}`)
  return `M${corners.join(' L')} Z`
}

function diamondPath(x, y, reach) {
  return `M${x.toFixed(1)} ${(y - reach).toFixed(1)} L${(x + reach).toFixed(1)} ${y.toFixed(1)} L${x.toFixed(1)} ${(y + reach).toFixed(1)} L${(x - reach).toFixed(1)} ${y.toFixed(1)} Z`
}
