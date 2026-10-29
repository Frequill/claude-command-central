// The board as a grid, laid out by GridStack.js: cards sit in 12 columns and in rows of 20 px.
// A card dragged by its header pushes the cards in its way down, and they slide aside while it moves,
// so where it lands is shown before it is let go. A card pulled by an edge or a corner grows and
// pushes the cards below it. Held near the top or the bottom of the window, a card scrolls the page.
// Cards stay where they are put: room left empty stays empty, until the person closes the gaps. An
// empty space offers a + to start something there, and a card dropped into one fills it.

import { edgeSpeed, holdHand, jelly } from './layout.js'

const GRID_KEY = 'ccc.grid'
export const COLUMNS = 12
export const ROW = 20
// each card keeps this much room on every side, so two cards have twice this between them
const MARGIN = 6
const LEAST = { w: 3, h: 16 }
const FIRST = { w: 6, h: 32 }
// what never starts a drag in a card's header: its buttons, links and boxes
const NOT_A_HANDLE = 'button, a, input, select, textarea, summary, [contenteditable], .setup-panel'

function load() {
  try {
    const kept = JSON.parse(localStorage.getItem(GRID_KEY) ?? '{}')
    return kept && typeof kept === 'object' ? kept : {}
  } catch {
    return {}
  }
}

function store(kept) {
  try {
    localStorage.setItem(GRID_KEY, JSON.stringify(kept))
  } catch {
    // a private window: the layout lasts until the board reloads
  }
}

const whole = (value, least, most) => Math.max(least, Math.min(most, Math.round(value)))

/**
 * A card's place in grid cells, from where the old free board kept it in pixels (its left and top,
 * its width and height), so a board moved over keeps its look as near as the grid allows.
 */
export function cellsOf(pixels, boardWidth) {
  if (!pixels || !(boardWidth > 0) || !Number.isFinite(pixels.x) || !Number.isFinite(pixels.y)) return null
  const column = boardWidth / COLUMNS
  const w = whole((pixels.w ?? FIRST.w * column) / column, LEAST.w, COLUMNS)
  return {
    x: whole(pixels.x / column, 0, COLUMNS - w),
    y: whole(pixels.y / ROW, 0, 10_000),
    w,
    h: whole((pixels.h ?? FIRST.h * ROW) / ROW, LEAST.h, 400),
  }
}

/**
 * Where a new card goes: at the very bottom of the board, where new things are added. It goes under
 * the half (left or right) that ends lowest: the board lifts cards into any room above them, so under
 * the other half it would rise into the room there instead of staying at the bottom.
 */
export function lowestSpot(nodes) {
  const halves = [0, FIRST.w].map(x => ({
    x,
    bottom: Math.max(0, ...nodes.filter(node => node.x < x + FIRST.w && node.x + node.w > x).map(node => node.y + node.h)),
  }))
  const spot = halves[1].bottom > halves[0].bottom ? halves[1] : halves[0]
  return { ...FIRST, x: spot.x, y: spot.bottom }
}

/**
 * The empty space around `cell` ({ x, y } in grid cells), as big as it goes: a rectangle no card
 * covers, from the top of the board down to where the lowest card ends. Grown both ways (wide first,
 * then tall first) and the bigger kept. Null on a card, or below every card.
 */
export function gapAt(nodes, cell, { columns = COLUMNS, rows } = {}) {
  const bottom = rows ?? Math.max(0, ...nodes.map(node => node.y + node.h))
  const taken = (x, y) => nodes.some(node => x >= node.x && x < node.x + node.w && y >= node.y && y < node.y + node.h)
  if (!(cell.x >= 0 && cell.x < columns && cell.y >= 0 && cell.y < bottom) || taken(cell.x, cell.y)) return null
  const free = (x0, x1, y0, y1) => {
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) if (taken(x, y)) return false
    return true
  }
  const grow = isWideFirst => {
    let [x0, x1, y0, y1] = [cell.x, cell.x, cell.y, cell.y]
    const wider = () => {
      while (x0 > 0 && free(x0 - 1, x0 - 1, y0, y1)) x0 -= 1
      while (x1 < columns - 1 && free(x1 + 1, x1 + 1, y0, y1)) x1 += 1
    }
    const taller = () => {
      while (y0 > 0 && free(x0, x1, y0 - 1, y0 - 1)) y0 -= 1
      while (y1 < bottom - 1 && free(x0, x1, y1 + 1, y1 + 1)) y1 += 1
    }
    if (isWideFirst) {
      wider()
      taller()
    } else {
      taller()
      wider()
    }
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
  }
  const [wide, tall] = [grow(true), grow(false)]
  return wide.w * wide.h >= tall.w * tall.h ? wide : tall
}

/** Whether a space is big enough for a card. */
export function isRoomForCard(gap) {
  return Boolean(gap) && gap.w >= LEAST.w && gap.h >= LEAST.h
}

// how long a + in a gap keeps the spot for the card it starts (a session started in the app comes later)
const PLACE_KEPT_MS = 3 * 60_000
// how long after landing in a gap a card still counts as where the person looks
const IN_GAP_MS = 10_000

/**
 * Makes `box` the grid. `onStart` and `onEnd` mark the time a card is held, so the board does not
 * redraw under it; `oldPlace(id)` is a card's place on the old free board, in pixels, if it had one;
 * `onAddAt(gap)` is the + in an empty space, clicked.
 */
export function makeGrid(box, { onStart, onEnd, oldPlace, wobbles, animates, onAddAt }) {
  // the bundle puts the class itself on the page
  const GridStack = window.GridStack.GridStack ?? window.GridStack
  // GridStack scrolls the page while a card is resized with the pointer within a row of the window's
  // edge, which on this board is under the bars, out of sight: as the card grows, the page scrolls on
  // and on. The board's own scrolling near the edges (below) takes its place, as it does for a drag.
  if (window.GridStack.Utils) window.GridStack.Utils.updateScrollResize = () => {}
  const grid = GridStack.init(
    {
      column: COLUMNS,
      cellHeight: ROW,
      margin: MARGIN,
      // a card stays where it is put: a gap above it stays, until the person closes the gaps
      float: true,
      // set, so GridStack sizes the board by its cards alone, not by the height kept while a card
      // moves (keptRoom below holds that from outside, in the stylesheet)
      minRow: 1,
      animate: animates?.() ?? true,
      // a card moves by its header, where the hand shows; the rest of it is for reading and writing
      handle: '.chat-head',
      // the board scrolls by where the pointer is (below), not by how much of a tall card is out of view
      draggable: { handle: '.chat-head', cancel: NOT_A_HANDLE, scroll: false },
      // every edge but the top, which is the header a card is moved by, and every corner
      resizable: { handles: 'e, se, s, sw, w, nw, ne' },
      // a narrow window shows one card a row
      columnOpts: { breakpoints: [{ w: 760, c: 1 }] },
    },
    box,
  )
  const kept = load()
  const items = new Map()
  const room = keptRoom(box, () => grid.getRow() * ROW)
  // cards put in a gap by its +: there, where the person is looking, the board does not go to them
  const placedInGap = new Map()
  // where the next new card goes: a gap whose + was clicked, kept a while for the card it starts
  let nextPlace = null

  const save = () => {
    for (const node of grid.engine.nodes) if (node.id) kept[node.id] = { x: node.x, y: node.y, w: node.w, h: node.h }
    store(kept)
  }
  // the hand closes on a header as it is pressed, before the card starts to move
  box.addEventListener('pointerdown', event => {
    if (event.button === 0 && event.target.closest?.('.chat-head') && !event.target.closest(NOT_A_HANDLE)) holdHand()
  })
  const scroller = followEdges()
  const gaps = gapMarks(box, () => grid.engine.nodes, onAddAt)
  // a card dropped into an empty space fills it: where every card was when the drag began, and the
  // space the pointer is in then, without the card being moved
  let drag = null
  grid.on('dragstart', (_, el) => {
    document.body.classList.add('is-dragging')
    room.hold()
    gaps.hide()
    const moved = el?.gridstackNode
    drag = moved ? { node: moved, from: { x: moved.x, y: moved.y, w: moved.w, h: moved.h }, before: grid.engine.nodes.filter(node => node !== moved).map(node => ({ node, x: node.x, y: node.y, w: node.w, h: node.h })), gap: null } : null
    scroller.start()
    onStart?.()
  })
  grid.on('drag', () => {
    if (!drag) return
    const cell = gaps.cellAt(scroller.pointer())
    const inOwnPlace = cell && cell.x >= drag.from.x && cell.x < drag.from.x + drag.from.w && cell.y >= drag.from.y && cell.y < drag.from.y + drag.from.h
    const gap = cell && !inOwnPlace ? gapAt(drag.before, cell) : null
    drag.gap = isRoomForCard(gap) ? gap : null
    gaps.target(drag.gap)
  })
  grid.on('resizestart', () => {
    document.body.classList.add('is-resizing')
    room.hold()
    scroller.start()
    onStart?.()
  })
  grid.on('dragstop resizestop', (event, el) => {
    // dropped into an empty space: the others go back to where they were, the card fills the space
    if (event.type === 'dragstop' && drag?.gap) {
      const gap = drag.gap
      grid.batchUpdate()
      for (const was of drag.before) {
        if (was.node.el && (was.node.x !== was.x || was.node.y !== was.y)) grid.update(was.node.el, { x: was.x, y: was.y })
      }
      grid.update(el, gap)
      grid.batchUpdate(false)
    }
    drag = null
    gaps.target(null)
    scroller.stop()
    document.body.classList.remove('is-dragging', 'is-resizing')
    room.release()
    if (wobbles?.() && el?.firstElementChild) jelly(el.firstElementChild)
    save()
    onEnd?.()
  })
  grid.on('change', save)

  return {
    /** Puts the card on the grid, where it was kept, else at the first free spot. */
    hold(id, card) {
      const item = items.get(id)
      if (item) {
        // a card drawn anew (another theme, a reset) goes back into its cell
        if (item.card !== card || !card.isConnected) {
          card.classList.add('grid-stack-item-content')
          if (item.card !== card && item.card.isConnected) item.card.replaceWith(card)
          else item.el.prepend(card)
          item.card = card
        }
        return
      }
      const el = document.createElement('div')
      el.className = 'grid-stack-item'
      card.classList.add('grid-stack-item-content')
      el.append(card)
      box.append(el)
      // a gap whose + was clicked, while it is still empty, else where it was kept, else at the bottom
      const spot = nextPlace && Date.now() - nextPlace.at < PLACE_KEPT_MS && !kept[id] && grid.isAreaEmpty(nextPlace.x, nextPlace.y, nextPlace.w, nextPlace.h) ? nextPlace : null
      if (spot) {
        nextPlace = null
        placedInGap.set(id, Date.now())
      }
      const place = spot ? { x: spot.x, y: spot.y, w: spot.w, h: spot.h } : kept[id] ?? cellsOf(oldPlace?.(id), box.clientWidth)
      grid.makeWidget(el, { id, minW: LEAST.w, minH: LEAST.h, ...(place ?? lowestSpot(grid.engine.nodes)) })
      items.set(id, { el, card })
    },
    /** Takes a card off the grid; the cards below rise into its place. */
    drop(id) {
      const item = items.get(id)
      if (!item) return
      // a card closed at the bottom: the board gets shorter only below what the person is looking at
      room.hold()
      grid.removeWidget(item.el, true, false)
      items.delete(id)
      room.release()
    },
    /** Whether the card was just put in a gap by its +, where the person is looking already. */
    isInGap: id => Date.now() - (placedInGap.get(id) ?? 0) < IN_GAP_MS,
    has: id => items.has(id),
    /** The next new card goes into this gap (null: wherever it would). */
    placeNext(gap) {
      nextPlace = gap ? { ...gap, at: Date.now() } : null
    },
    /** The cards packed together again, top first, each keeping its size. */
    closeGaps() {
      grid.compact('compact')
      save()
    },
    ids: () => [...items.keys()],
    /** Every card back to the first free spots, in the board's order, at the size a card starts at. */
    reset(order) {
      for (const id of Object.keys(kept)) delete kept[id]
      grid.batchUpdate()
      order.forEach((id, index) => {
        const item = items.get(id)
        if (item) grid.update(item.el, { x: (index % 2) * FIRST.w, y: Math.floor(index / 2) * FIRST.h, w: FIRST.w, h: FIRST.h })
      })
      grid.batchUpdate(false)
      save()
    },
    /** Motion on or off, as the settings say. */
    animate: isOn => grid.setAnimation(isOn),
    grid,
  }
}

/**
 * While a card is held, the pointer near the top or the bottom of the room the pinned bars leave
 * scrolls the page, faster the nearer; the card goes along, as the pointer moved under it.
 */
function followEdges() {
  let last = null
  let frame = 0
  // the moves this sends itself are not where the pointer went
  const nudges = new WeakSet()
  const track = event => {
    if (!nudges.has(event)) last = { x: event.clientX, y: event.clientY }
  }
  const tick = () => {
    frame = requestAnimationFrame(tick)
    const by = last ? edgeSpeed(last.y) : 0
    if (!by) return
    const before = window.scrollY
    window.scrollBy(0, by)
    // the grid places the card on the next move of the mouse: one at the same spot, the page moved under it
    if (window.scrollY === before) return
    const nudge = new MouseEvent('mousemove', { bubbles: true, clientX: last.x, clientY: last.y, buttons: 1 })
    nudges.add(nudge)
    document.dispatchEvent(nudge)
  }
  return {
    /** Where the pointer is while a card is held: { x, y } in the window, or null. */
    pointer: () => last,
    start() {
      window.addEventListener('mousemove', track, true)
      frame = requestAnimationFrame(tick)
    },
    stop() {
      window.removeEventListener('mousemove', track, true)
      cancelAnimationFrame(frame)
      last = null
    },
  }
}

/**
 * The marks drawn over empty spaces: a + offering to start something in the space under the pointer,
 * and, while a card is held over one, its outline, where the card will land and how big. Kept in the
 * grid's box, which places them; `cellAt` is the grid cell under a point of the window.
 */
function gapMarks(box, nodes, onAddAt) {
  const MARGIN = 6
  const mark = document.createElement('div')
  mark.className = 'grid-gap'
  mark.hidden = true
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'grid-gap-add'
  add.title = 'Start a session or a terminal in this space'
  add.setAttribute('aria-label', 'Start something in this space')
  add.textContent = '+'
  mark.append(add)
  box.append(mark)
  let shown = null
  const place = gap => {
    const column = box.clientWidth / COLUMNS
    mark.style.left = `${gap.x * column + MARGIN}px`
    mark.style.top = `${gap.y * ROW + MARGIN}px`
    mark.style.width = `${gap.w * column - 2 * MARGIN}px`
    mark.style.height = `${gap.h * ROW - 2 * MARGIN}px`
  }
  const cellAt = point => {
    if (!point) return null
    const area = box.getBoundingClientRect()
    return { x: Math.floor(((point.x - area.left) / area.width) * COLUMNS), y: Math.floor((point.y - area.top) / ROW) }
  }
  const hide = () => {
    shown = null
    mark.hidden = true
    mark.classList.remove('is-target')
  }
  box.addEventListener('mousemove', event => {
    if (document.body.classList.contains('is-dragging') || document.body.classList.contains('is-resizing')) return
    if (event.target.closest?.('.grid-stack-item')) return hide()
    if (event.target.closest?.('.grid-gap') && shown) return
    const gap = gapAt(nodes(), cellAt({ x: event.clientX, y: event.clientY }))
    if (!isRoomForCard(gap)) return hide()
    shown = gap
    place(gap)
    mark.hidden = false
  })
  box.addEventListener('mouseleave', hide)
  add.addEventListener('click', () => {
    const gap = shown
    hide()
    if (gap) onAddAt?.(gap)
  })
  return {
    cellAt,
    hide,
    /** The outline of the space a held card will fill, or none. */
    target(gap) {
      mark.classList.toggle('is-target', Boolean(gap))
      mark.hidden = !gap
      if (gap) place(gap)
    },
  }
}

/**
 * The board's height, kept so the view never jumps: while a card is moved or resized, and as one is
 * closed, the board stays at least as tall as it was. After, it gives back only the room below what
 * the person is looking at, and more as they scroll up, so the page under the view never moves.
 */
function keptRoom(box, contentHeight) {
  const keep = value => (value > 0 ? box.style.setProperty('--grid-keep', `${Math.round(value)}px`) : box.style.removeProperty('--grid-keep'))
  const kept = () => parseFloat(box.style.getPropertyValue('--grid-keep')) || 0
  const release = () => {
    const held = kept()
    if (!held) return
    const below = document.scrollingElement.scrollHeight - (window.scrollY + window.innerHeight)
    const next = held - Math.max(0, below)
    keep(next > contentHeight() ? next : 0)
  }
  let waiting = 0
  window.addEventListener(
    'scroll',
    () => {
      if (!kept() || waiting) return
      waiting = setTimeout(() => {
        waiting = 0
        if (!document.body.classList.contains('is-dragging') && !document.body.classList.contains('is-resizing')) release()
      }, 100)
    },
    { passive: true },
  )
  return {
    hold: () => keep(Math.max(kept(), box.offsetHeight)),
    release,
  }
}
