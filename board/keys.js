// The board's keyboard shortcuts: which keys run which command, as text the settings can keep and
// show. A shortcut is written as its modifiers in a fixed order and then the physical key, as the
// browser names it in `event.code`: "Alt+Meta+ArrowLeft", "Meta+KeyT", "Control+Shift+Tab". The
// physical key, not the letter it types, so a shortcut matches on any keyboard layout: with Cmd
// held, Chrome reports some keys without Shift, and symbols sit on other keys in other layouts.

// the modifiers in the order a shortcut is written, and as a Mac shows them
export const MODIFIERS = ['Control', 'Alt', 'Shift', 'Meta']
const MODIFIER_MARKS = { Control: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }
const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS', 'CapsLock', 'Fn', 'FnLock', 'AltGraph'])
// a key's code, as the browser names it: KeyT, Digit1, ArrowLeft, Tab, F5, BracketRight…
const CODE = /^[A-Z][A-Za-z0-9]{1,24}$/

// keys a page never gets, or that would do something else on a Mac: kept by Chrome or by macOS
const TAKEN = {
  'Meta+KeyE': 'Chrome keeps it',
  'Meta+KeyQ': 'macOS quits the browser with it',
  'Meta+KeyH': 'macOS hides the window with it',
  'Meta+KeyM': 'macOS minimises the window with it',
  'Meta+Tab': 'macOS switches apps with it',
  'Meta+Backquote': 'macOS switches windows with it',
}

/**
 * The commands a shortcut can run, in the order the Keys tab lists them, each with its default
 * keys. Ids are what the settings keep, so an id is never renamed.
 */
export const COMMANDS = [
  { id: 'newSession', label: 'New session', group: 'Sessions', keys: ['Meta+KeyT'] },
  // no key until the person gives it one
  { id: 'quickNew', label: 'Quick new session (in the background, no window)', group: 'Sessions', keys: [] },
  { id: 'newTerminal', label: 'New terminal', group: 'Sessions', keys: ['Alt+Meta+KeyT'] },
  { id: 'closeCard', label: 'Close the current card', group: 'Sessions', keys: ['Meta+KeyW'] },
  { id: 'palette', label: 'Command palette', group: 'Sessions', keys: ['Meta+KeyK'] },
  { id: 'cardLeft', label: 'Card to the left', group: 'Moving between cards', keys: ['Alt+Meta+ArrowLeft'] },
  { id: 'cardRight', label: 'Card to the right', group: 'Moving between cards', keys: ['Alt+Meta+ArrowRight'] },
  { id: 'cardUp', label: 'Card above', group: 'Moving between cards', keys: ['Alt+Meta+ArrowUp'] },
  { id: 'cardDown', label: 'Card below', group: 'Moving between cards', keys: ['Alt+Meta+ArrowDown'] },
  { id: 'cardNext', label: 'Next card', group: 'Moving between cards', keys: ['Control+Tab'] },
  { id: 'cardPrevious', label: 'Previous card', group: 'Moving between cards', keys: ['Control+Shift+Tab'] },
  { id: 'needsYou', label: 'Next card that needs you', group: 'Moving between cards', keys: ['Alt+Meta+KeyN'] },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `card${i + 1}`, label: `Card ${i + 1}`, group: 'Moving between cards', keys: [`Meta+Digit${i + 1}`] })),
  // Ctrl+C as in a terminal, ⌘. as in a Mac app; a terminal card keeps Ctrl+C for its shell (board.js)
  { id: 'stop', label: 'Stop Claude in the current card', group: 'The current card', keys: ['Meta+Period', 'Control+KeyC'] },
  { id: 'renameCard', label: 'Rename the current card', group: 'The current card', keys: ['F2'] },
  { id: 'sessionMenu', label: 'Model, effort and mode menu', group: 'The current card', keys: ['Shift+Meta+KeyM'] },
  { id: 'factsPanel', label: 'Facts panel on or off', group: 'The current card', keys: ['Meta+KeyJ'] },
  { id: 'terminal', label: 'Its terminal on or off (in the background)', group: 'The current card', keys: ['Shift+Meta+KeyE'] },
  { id: 'caveman', label: 'Caveman on or off', group: 'The current card', keys: ['Shift+Meta+KeyK'] },
  { id: 'settings', label: 'Settings', group: 'The board', keys: ['Meta+Comma'] },
]

const COMMAND_IDS = new Set(COMMANDS.map(command => command.id))

/** The shortcut a key press is, or null for a modifier pressed on its own. */
export function chordOf(event) {
  const code = event?.code
  if (typeof code !== 'string' || !CODE.test(code) || MODIFIER_KEYS.has(event.key) || /^(Shift|Control|Alt|Meta|OS)(Left|Right)$/.test(code)) return null
  const held = { Control: event.ctrlKey, Alt: event.altKey, Shift: event.shiftKey, Meta: event.metaKey }
  return [...MODIFIERS.filter(name => held[name]), code].join('+')
}

/** A shortcut written the one way it is kept and matched, or null when the text is none. */
export function normalChord(text) {
  const parts = String(text ?? '').split('+').map(part => part.trim()).filter(Boolean)
  const code = parts.pop()
  if (!code || !CODE.test(code) || MODIFIERS.includes(code)) return null
  if (parts.some(part => !MODIFIERS.includes(part))) return null
  const held = new Set(parts)
  if (held.size !== parts.length) return null
  return [...MODIFIERS.filter(name => held.has(name)), code].join('+')
}

// how a key is named when the keyboard does not say, by its code
const KEY_NAMES = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Tab: 'Tab', Enter: '↩', Escape: 'Esc', Space: 'Space',
  Backspace: '⌫', Delete: '⌦', Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down',
  Period: '.', Comma: ',', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backquote: '`',
}

/**
 * A shortcut as a Mac shows it: "⌥⌘←", "⌘T", "⌃⇧Tab". `layout` is the keyboard's own map of codes to
 * what they type (Chrome's `navigator.keyboard.getLayoutMap()`), so a symbol shows as it is on
 * this keyboard; without one the US names are used.
 */
export function formatChord(chord, layout = null) {
  const normal = normalChord(chord)
  if (!normal) return ''
  const parts = normal.split('+')
  const code = parts.pop()
  const marks = parts.map(name => MODIFIER_MARKS[name]).join('')
  return marks + keyName(code, layout)
}

function keyName(code, layout) {
  if (KEY_NAMES[code] && !(code in PUNCTUATION_CODES)) return KEY_NAMES[code]
  const typed = typeof layout?.get === 'function' ? layout.get(code) : undefined
  if (typeof typed === 'string' && typed.trim()) return typed.length === 1 ? typed.toUpperCase() : typed
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`
  return KEY_NAMES[code] ?? code
}

// the keys that type a different symbol on other layouts: shown as this keyboard has them
const PUNCTUATION_CODES = { Period: 1, Comma: 1, Slash: 1, Backslash: 1, Semicolon: 1, Quote: 1, Minus: 1, Equal: 1, BracketLeft: 1, BracketRight: 1, Backquote: 1 }

/** Why a page cannot use the shortcut (Chrome or macOS keeps it), or ''. */
export function takenBy(chord) {
  return TAKEN[normalChord(chord)] ?? ''
}

/**
 * Each command's keys: its defaults, or the person's own where they changed them. `custom` is what
 * the settings keep, { commandId: [chords] }; an empty list leaves the command with no key.
 */
export function bindings(custom = {}) {
  const own = custom && typeof custom === 'object' ? custom : {}
  return Object.fromEntries(
    COMMANDS.map(command => {
      const chosen = Array.isArray(own[command.id]) ? own[command.id].map(normalChord).filter(Boolean) : null
      return [command.id, chosen ?? command.keys.map(normalChord).filter(Boolean)]
    }),
  )
}

/** The person's own keys with what no longer fits taken out: unknown commands, broken shortcuts, defaults. */
export function cleanCustom(custom) {
  const kept = {}
  for (const [id, keys] of Object.entries(custom && typeof custom === 'object' ? custom : {})) {
    if (!COMMAND_IDS.has(id) || !Array.isArray(keys)) continue
    const normal = [...new Set(keys.map(normalChord).filter(Boolean))]
    const defaults = COMMANDS.find(command => command.id === id).keys
    if (normal.length !== defaults.length || normal.some((chord, i) => chord !== defaults[i])) kept[id] = normal
  }
  return kept
}

/** Which command a shortcut runs, for each shortcut bound: Map chord → command id. The first command listed wins a clash. */
export function keymap(custom = {}) {
  const map = new Map()
  for (const [id, keys] of Object.entries(bindings(custom))) for (const chord of keys) if (!map.has(chord)) map.set(chord, id)
  return map
}

/** The shortcuts bound to more than one command: [{ chord, ids }], for the Keys tab to warn about. */
export function clashes(custom = {}) {
  const byChord = new Map()
  for (const [id, keys] of Object.entries(bindings(custom))) for (const chord of keys) byChord.set(chord, [...(byChord.get(chord) ?? []), id])
  return [...byChord].filter(([, ids]) => ids.length > 1).map(([chord, ids]) => ({ chord, ids }))
}

/** The command a key press runs, or null. */
export function commandFor(event, map) {
  const chord = chordOf(event)
  return chord ? (map.get(chord) ?? null) : null
}

// how much a card off to the side counts against it, against how far ahead it is: twice its distance
const ASIDE_WEIGHT = 2
const DIRECTIONS = { left: ['x', -1], right: ['x', 1], up: ['y', -1], down: ['y', 1] }

/**
 * The card to go to from `from` in a direction ('left', 'right', 'up', 'down'). Cards are { id, x,
 * y, w, h } as the screen has them. A card counts only when its near edge is past the middle of
 * `from` that way. Cards in line with `from` (sharing some of its height for left and right, some
 * of its width for up and down) come before ones off to the side; then the nearest; then the one
 * most in line. Null when there is none that way: the keys never wrap round.
 */
export function cardInDirection(from, cards, direction) {
  const way = DIRECTIONS[direction]
  if (!from || !way) return null
  const [axis, sign] = way
  const size = axis === 'x' ? 'w' : 'h'
  const other = axis === 'x' ? 'y' : 'x'
  const otherSize = axis === 'x' ? 'h' : 'w'
  const middle = (card, along) => card[along] + card[along === 'x' ? 'w' : 'h'] / 2
  const start = middle(from, axis)
  let best = null
  for (const card of cards) {
    if (!card || card.id === from.id || !(card.w > 0 && card.h > 0)) continue
    // its near edge must be past the middle of `from`: a card below that reaches further right is not to the right
    const nearEdge = sign > 0 ? card[axis] : card[axis] + card[size]
    if ((nearEdge - start) * sign < 0) continue
    const ahead = (middle(card, axis) - start) * sign
    if (ahead <= 1) continue
    const aside = Math.max(0, card[other] - (from[other] + from[otherSize]), from[other] - (card[other] + card[otherSize]))
    const rank = [aside > 0 ? 1 : 0, ahead + aside * ASIDE_WEIGHT, Math.abs(middle(card, other) - middle(from, other))]
    if (!best || rank[0] < best.rank[0] || (rank[0] === best.rank[0] && (rank[1] < best.rank[1] || (rank[1] === best.rank[1] && rank[2] < best.rank[2])))) best = { card, rank }
  }
  return best?.card ?? null
}

/** Where the keys start when no card is current yet: the card nearest the top left. */
export function firstCard(cards) {
  return [...cards].filter(card => card && card.w > 0 && card.h > 0).sort((a, b) => a.y + a.x / 4 - (b.y + b.x / 4))[0] ?? null
}

/**
 * What an arrow key does in a group of buttons (a row of the session menu, a question's options):
 * 'next' or 'previous' along the group, or 'rowDown' / 'rowUp' to the group below or above. A row
 * runs ← →, a list (`vertical`) runs ↑ ↓; null for a key that does nothing in it.
 */
export function arrowStep(key, isVertical = false) {
  if (isVertical) return { ArrowDown: 'next', ArrowUp: 'previous' }[key] ?? null
  return { ArrowRight: 'next', ArrowLeft: 'previous', ArrowDown: 'rowDown', ArrowUp: 'rowUp' }[key] ?? null
}

/** The place of the one nearest to `x` among `xs` (each button's middle), for landing in the row above or below. */
export function nearestIndex(xs, x) {
  let best = -1
  xs.forEach((one, i) => {
    if (best < 0 || Math.abs(one - x) < Math.abs(xs[best] - x)) best = i
  })
  return best
}

// cards whose tops are this close are in one row, for reading order
const ROW_SLACK = 24

/** The cards in reading order, as the board shows them: row by row from the top, each row from the left. */
export function readingOrder(cards) {
  return [...cards]
    .filter(card => card && card.w > 0 && card.h > 0)
    .sort((a, b) => (Math.abs(a.y - b.y) <= ROW_SLACK ? a.x - b.x : a.y - b.y))
}

/**
 * The card `by` places on from the one with `currentId` in reading order (1 next, -1 previous),
 * round from the end to the start as browser tabs go. With none current, the first (or last).
 */
export function cardInOrder(cards, currentId, by) {
  const order = readingOrder(cards)
  if (!order.length) return null
  const at = order.findIndex(card => card.id === currentId)
  if (at < 0) return by > 0 ? order[0] : order.at(-1)
  return order[(at + by + order.length) % order.length]
}

/** Card `n` (1 to 9) in reading order; 9 is the last card, as Cmd+9 is the last tab in a browser. */
export function cardNumber(cards, n) {
  const order = readingOrder(cards)
  return (n >= 9 ? order.at(-1) : order[n - 1]) ?? null
}

/** The next card after the current one, in reading order and round again, that `isWaiting` says needs the person. */
export function nextWaiting(cards, currentId, isWaiting) {
  const order = readingOrder(cards)
  const at = order.findIndex(card => card.id === currentId)
  for (let step = 1; step <= order.length; step++) {
    const card = order[(Math.max(at, -1) + step + order.length) % order.length]
    if (card.id !== currentId && isWaiting(card)) return card
  }
  return null
}

/**
 * Why a shortcut cannot be bound, or '' when it can. It needs Cmd, Ctrl or Option (or is a function
 * key), so typing is never taken over; and a page never gets the keys Chrome or macOS keep.
 */
export function bindProblem(chord) {
  const normal = normalChord(chord)
  if (!normal) return 'That is not a key.'
  const parts = normal.split('+')
  const code = parts.at(-1)
  const isFunctionKey = /^F\d{1,2}$/.test(code)
  if (!isFunctionKey && !parts.some(part => part === 'Control' || part === 'Alt' || part === 'Meta')) return 'Add Cmd, Ctrl or Option, so typing stays as it is.'
  if (TAKEN[normal]) return `${formatChord(normal)} can’t be used: ${TAKEN[normal]}.`
  return ''
}

/** The person's own keys with `chord` on `id`, taken off any other command that had it: { custom, movedFrom }. */
export function rebind(custom, id, chord) {
  const normal = normalChord(chord)
  const now = bindings(custom)
  const next = { ...cleanCustom(custom) }
  const movedFrom = []
  for (const [other, keys] of Object.entries(now)) {
    if (other !== id && keys.includes(normal)) {
      next[other] = keys.filter(one => one !== normal)
      movedFrom.push(other)
    }
  }
  next[id] = [normal]
  return { custom: cleanCustom(next), movedFrom }
}

/** The palette's rows for what was typed: each word somewhere in the row's words, rows whose name starts with it first. */
export function paletteMatches(rows, typed) {
  const words = String(typed ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return rows
  const hits = rows.filter(row => {
    const text = `${row.label} ${row.detail ?? ''}`.toLowerCase()
    return words.every(word => text.includes(word))
  })
  const starts = row => (row.label.toLowerCase().startsWith(words[0]) ? 0 : 1)
  return hits.map((row, i) => [row, i]).sort((a, b) => starts(a[0]) - starts(b[0]) || a[1] - b[1]).map(([row]) => row)
}

/** The option number a key press picks in a waiting box (1 to 9, the row of digits or the number pad), or 0. */
export function optionNumber(event) {
  if (!event || event.metaKey || event.ctrlKey || event.altKey) return 0
  const found = /^(?:Digit|Numpad)([1-9])$/.exec(String(event.code ?? ''))
  return found ? Number(found[1]) : 0
}

/**
 * The card to go on to after `gone` closed, as with a closed browser tab: a neighbour in the same
 * row first (one sharing some of its height), the nearest of those; else the nearest card anywhere,
 * by the distance between their middles. So the keys go on from there, not from the top of the board.
 * Null with no card left.
 */
export function nearestCard(gone, cards) {
  if (!gone) return null
  const middle = card => ({ x: card.x + card.w / 2, y: card.y + card.h / 2 })
  const from = middle(gone)
  const left = cards.filter(card => card && card.id !== gone.id && card.w > 0 && card.h > 0)
  const inRow = left.filter(card => card.y < gone.y + gone.h && card.y + card.h > gone.y)
  let best = null
  for (const card of inRow.length ? inRow : left) {
    const at = middle(card)
    const distance = Math.hypot(at.x - from.x, at.y - from.y)
    if (!best || distance < best.distance) best = { card, distance }
  }
  return best?.card ?? null
}

/**
 * Where the board scrolls back up to after cards closed, or null to stay: when the part of the
 * window that shows the board (`shown` high, from `top`) is a third or more empty below `lowest`
 * (the bottom of the lowest card left, on the page), up until that bottom meets the window's.
 */
export function backUpTo(top, shown, lowest) {
  if (top + shown - lowest < shown / 3) return null
  const to = Math.max(0, lowest - shown)
  return to < top ? to : null
}

/** Whether a key press is one a shell takes: Ctrl and a key, with no Cmd or Option (Ctrl+C, Ctrl+R…). */
export function isShellKey(event) {
  return Boolean(event?.ctrlKey) && !event.metaKey && !event.altKey
}
