// The board as a grid, laid out by GridStack.js: cards sit in 12 columns and in rows of 20 px.
// A card dragged by its header pushes the cards in its way down, and they slide aside while it moves,
// so where it lands is shown before it is let go. A card pulled by an edge or a corner grows and
// pushes the cards below it. Held near the top or the bottom of the window, a card scrolls the page.

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
 * Makes `box` the grid. `onStart` and `onEnd` mark the time a card is held, so the board does not
 * redraw under it; `oldPlace(id)` is a card's place on the old free board, in pixels, if it had one.
 */
export function makeGrid(box, { onStart, onEnd, oldPlace, wobbles, animates }) {
  // the bundle puts the class itself on the page
  const GridStack = window.GridStack.GridStack ?? window.GridStack
  const grid = GridStack.init(
    {
      column: COLUMNS,
      cellHeight: ROW,
      margin: MARGIN,
      // the cards rise to fill a gap above them, as a list closes up
      float: false,
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

  const save = () => {
    for (const node of grid.engine.nodes) if (node.id) kept[node.id] = { x: node.x, y: node.y, w: node.w, h: node.h }
    store(kept)
  }
  // the hand closes on a header as it is pressed, before the card starts to move
  box.addEventListener('pointerdown', event => {
    if (event.button === 0 && event.target.closest?.('.chat-head') && !event.target.closest(NOT_A_HANDLE)) holdHand()
  })
  const scroller = followEdges()
  grid.on('dragstart', () => {
    document.body.classList.add('is-dragging')
    scroller.start()
    onStart?.()
  })
  grid.on('resizestart', () => {
    document.body.classList.add('is-resizing')
    onStart?.()
  })
  grid.on('dragstop resizestop', (_, el) => {
    scroller.stop()
    document.body.classList.remove('is-dragging', 'is-resizing')
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
      const place = kept[id] ?? cellsOf(oldPlace?.(id), box.clientWidth)
      grid.makeWidget(el, { id, minW: LEAST.w, minH: LEAST.h, ...(place ?? lowestSpot(grid.engine.nodes)) })
      items.set(id, { el, card })
    },
    /** Takes a card off the grid; the cards below rise into its place. */
    drop(id) {
      const item = items.get(id)
      if (!item) return
      grid.removeWidget(item.el, true, false)
      items.delete(id)
    },
    has: id => items.has(id),
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
