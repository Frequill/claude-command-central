// The board as a grid, laid out by GridStack.js: cards sit in 12 columns and in rows of 20 px.
// A card dragged by its header pushes the cards in its way down, and they slide aside while it moves,
// so where it lands is shown before it is let go. A card pulled by an edge or a corner grows, and the
// cards in its way get smaller to make room, down to their smallest; they are never pushed away. A
// card moved near the top or the bottom of the window scrolls the page; a card resized never does,
// so the view stays where the person is looking.
// Cards stay where they are put: room left empty stays empty, until the person closes the gaps. An
// empty space offers a + to start something there, and an empty strip across the whole board a −
// that closes it, the cards below moving up. A card dropped keeps its size; dropped into an
// empty space with Shift held, it fills the space. A card held over the lower half of a card below it
// in its column goes under it, and the cards between rise into the room it left; over the upper half
// of a card above it, it goes above, and they go down.

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

/**
 * The empty strip across the whole board at `row`: rows no card covers, from one side of the board to
 * the other, with a card below them ({ y, h } in rows). Null on a row a card covers, or below every card.
 */
export function stripAt(nodes, row) {
  const bottom = Math.max(0, ...nodes.map(node => node.y + node.h))
  const isEmpty = y => !nodes.some(node => y >= node.y && y < node.y + node.h)
  if (!(row >= 0 && row < bottom) || !isEmpty(row)) return null
  let [top, last] = [row, row]
  while (top > 0 && isEmpty(top - 1)) top -= 1
  while (isEmpty(last + 1)) last += 1
  return { y: top, h: last - top + 1 }
}

/** The strip closed: every card below it moves up by its height, and none changes size. */
export function closedStrip(nodes, strip) {
  return nodes.filter(node => node.y >= strip.y + strip.h).map(node => ({ node, y: node.y - strip.h }))
}

/**
 * A card moved past others in its own column, as in a list. Held over the lower half of a card below
 * it, that card and the ones between rise into the room it leaves, and it goes under them. Held over
 * the upper half of a card above it, that card and the ones between go down by its height, and it goes
 * above them. `from` is where the card was when the drag began, `others` where every other card was
 * ({ x, y, w, h } and anything else), `cell` the cell under the pointer. Gives the card's new place and
 * the cards that move, each with its new y, or null when the pointer passes nothing or they do not fit.
 */
export function passedAt(from, others, cell) {
  if (!cell) return null
  const under = others.find(node => cell.x >= node.x && cell.x < node.x + node.w && cell.y >= node.y && cell.y < node.y + node.h)
  const inColumn = node => node.x < from.x + from.w && node.x + node.w > from.x
  if (!under || !inColumn(under)) return null
  let passed
  let shift
  let spot
  if (under.y >= from.y + from.h && cell.y >= under.y + under.h / 2) {
    passed = others.filter(node => inColumn(node) && node.y >= from.y + from.h && node.y <= under.y)
    shift = -from.h
    spot = { x: from.x, y: under.y + under.h - from.h, w: from.w, h: from.h }
  } else if (under.y + under.h <= from.y && cell.y < under.y + under.h / 2) {
    passed = others.filter(node => inColumn(node) && node.y + node.h <= from.y && node.y >= under.y)
    shift = from.h
    spot = { x: from.x, y: under.y, w: from.w, h: from.h }
  } else {
    return null
  }
  const moved = passed.map(node => ({ ...node, y: node.y + shift }))
  // a card that moves may not land on one that stays, nor on another that moves or the held card
  const stays = others.filter(node => !passed.includes(node))
  const landing = [spot, ...moved]
  const fits = landing.every((rect, index) => rect.y >= 0 && !stays.some(node => overlaps(rect, node)) && !landing.some((other, at) => at !== index && overlaps(rect, other)))
  return fits ? { spot, moved } : null
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/**
 * A card resized: a card in its way gets smaller to make room, from the side that faces it, and is
 * never pushed away. When a card in the way is at its smallest, the resized card stops there. `from`
 * is the card's place when the resize began, `to` the place the pointer asks for, `others` where
 * every other card was then ({ x, y, w, h } and anything else). Gives the card's place and the cards
 * that got smaller, each with its new place.
 */
export function resizedTo(from, to, others) {
  // the card in the way, smaller: of the sides that face the resized card, the one that leaves it biggest
  const madeRoom = (node, rect) => {
    const ways = []
    if (node.y + node.h <= from.y) ways.push({ ...node, h: rect.y - node.y })
    if (node.y >= from.y + from.h) ways.push({ ...node, y: rect.y + rect.h, h: node.y + node.h - (rect.y + rect.h) })
    if (node.x + node.w <= from.x) ways.push({ ...node, w: rect.x - node.x })
    if (node.x >= from.x + from.w) ways.push({ ...node, x: rect.x + rect.w, w: node.x + node.w - (rect.x + rect.w) })
    const fitting = ways.filter(way => way.w >= LEAST.w && way.h >= LEAST.h)
    return fitting.sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? null
  }
  const edges = rect => [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h]
  const goal = edges(from)
  let rect = { ...to }
  // each edge that moved goes back a cell at a time, until every card in the way has room to give
  for (;;) {
    const given = []
    const isRoom = others.every(node => {
      if (!overlaps(rect, node)) return true
      const smaller = madeRoom(node, rect)
      if (smaller) given.push(smaller)
      return Boolean(smaller)
    })
    if (isRoom) return { spot: rect, given }
    const now = edges(rect)
    if (now.every((edge, index) => edge === goal[index])) return { spot: { ...from }, given: [] }
    const [left, top, right, bottom] = now.map((edge, index) => edge + Math.sign(goal[index] - edge))
    rect = { x: left, y: top, w: right - left, h: bottom - top }
  }
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
  // and on. A resize leaves the page where it is.
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
      // every edge and every corner; the top is a thin strip, the rest of the header moves the card
      resizable: { handles: 'n, e, se, s, sw, w, nw, ne' },
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
  // an empty strip closed: the cards below move up, top first, and the view stays where it is
  const closeStrip = strip => {
    room.hold()
    grid.batchUpdate()
    for (const { node, y } of closedStrip(grid.engine.nodes, strip).sort((a, b) => a.y - b.y)) grid.update(node.el, { y })
    grid.batchUpdate(false)
    save()
    room.release()
  }
  const gaps = gapMarks(box, () => grid.engine.nodes, onAddAt, closeStrip)
  // the card held, where it and every other card were when it was taken, and the empty space it
  // would fill if let go now
  let held = null
  const take = el => {
    const node = el?.gridstackNode
    held = node ? { node, from: { x: node.x, y: node.y, w: node.w, h: node.h }, before: grid.engine.nodes.filter(other => other !== node).map(other => ({ node: other, x: other.x, y: other.y, w: other.w, h: other.h })), gap: null, isShift: false } : null
  }
  // a card dropped where it is let go keeps its size; with Shift held, dropped into an empty space it
  // fills it, and the space is outlined while it is held there. Without Shift, the space says so.
  const aim = (pointer = scroller.pointer()) => {
    if (!held || !document.body.classList.contains('is-dragging')) return
    const cell = gaps.cellAt(pointer)
    const inOwnPlace = cell && cell.x >= held.from.x && cell.x < held.from.x + held.from.w && cell.y >= held.from.y && cell.y < held.from.y + held.from.h
    const gap = cell && !inOwnPlace ? gapAt(held.before, cell) : null
    const space = isRoomForCard(gap) ? gap : null
    held.gap = held.isShift ? space : null
    gaps.target(space, { isFilled: held.isShift, pointer })
  }
  // Shift pressed or let go, or the pointer moved: the space under it and its label follow at once
  const onShift = event => {
    if (!held) return
    held.isShift = event.shiftKey
    aim(event.type === 'mousemove' ? { x: event.clientX, y: event.clientY } : undefined)
  }
  for (const type of ['keydown', 'keyup', 'mousemove']) window.addEventListener(type, onShift, true)
  grid.on('dragstart', (_, el) => {
    document.body.classList.add('is-dragging')
    room.hold()
    gaps.hide()
    take(el)
    scroller.start()
    onStart?.()
  })
  grid.on('drag', () => aim())
  // GridStack only pushes the cards in the way down, both for a card moved and for one resized. Here a
  // card moved past others in its own column has them make room as in a list (passedAt), and a card
  // resized has the ones in its way get smaller (resizedTo), while it is held, so where everything
  // lands shows before it is let go.
  const moveNodeCheck = grid.engine.moveNodeCheck.bind(grid.engine)
  const placeAll = (spot, changed = []) => {
    const set = (node, place) => {
      if (node.x === place.x && node.y === place.y && node.w === place.w && node.h === place.h) return
      Object.assign(node, { x: place.x, y: place.y, w: place.w, h: place.h, _dirty: true })
    }
    set(held.node, spot)
    for (const was of held.before) set(was.node, changed.find(other => other.node === was.node) ?? was)
    grid.engine._notify()
  }
  grid.engine.moveNodeCheck = (node, to) => {
    if (!held || node !== held.node) return moveNodeCheck(node, to)
    if (to.resizing) {
      const w = Math.min(to.w ?? node.w, COLUMNS)
      const asked = { x: Math.max(0, Math.min(to.x ?? node.x, COLUMNS - w)), y: Math.max(0, to.y ?? node.y), w, h: to.h ?? node.h }
      const { spot, given } = resizedTo(held.from, asked, held.before)
      placeAll(spot, given)
      return true
    }
    const pass = passedAt(held.from, held.before, gaps.cellAt(scroller.pointer()))
    if (pass) {
      placeAll(pass.spot, pass.moved)
      held.isPassing = true
      return true
    }
    // the pointer left: every card back where it was, then GridStack moves the held one as it would
    if (held.isPassing) {
      placeAll(held.from)
      held.isPassing = false
    }
    return moveNodeCheck(node, to)
  }
  grid.on('resizestart', (_, el) => {
    document.body.classList.add('is-resizing')
    room.hold()
    take(el)
    onStart?.()
  })
  grid.on('dragstop resizestop', (event, el) => {
    // dropped into an empty space with Shift: the others go back to where they were, the card fills it
    if (event.type === 'dragstop' && held?.gap) {
      const gap = held.gap
      grid.batchUpdate()
      for (const was of held.before) {
        if (was.node.el && (was.node.x !== was.x || was.node.y !== was.y)) grid.update(was.node.el, { x: was.x, y: was.y })
      }
      grid.update(el, gap)
      grid.batchUpdate(false)
    }
    held = null
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
function gapMarks(box, nodes, onAddAt, onCloseStrip) {
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
  // over an empty space without Shift, a card held says how to fill it, just above the pointer, where
  // the card does not cover it
  const hint = document.createElement('span')
  hint.className = 'grid-gap-hint'
  hint.textContent = 'Hold Shift to fill this space'
  hint.hidden = true
  document.body.append(hint)
  // an empty strip across the whole board offers a − that closes it: the cards below move up
  const strip = document.createElement('div')
  strip.className = 'grid-strip'
  strip.hidden = true
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'grid-strip-close'
  close.title = 'Close this empty space: the cards below move up, and no card changes size'
  close.setAttribute('aria-label', 'Close this empty space')
  close.textContent = '−'
  strip.append(close)
  box.append(mark, strip)
  let shown = null
  let shownStrip = null
  const showStrip = found => {
    shownStrip = found
    strip.hidden = !found
    if (!found) return
    // from the bottom of the cards above to the top of the cards below
    strip.style.top = `${found.y * ROW - MARGIN}px`
    strip.style.height = `${found.h * ROW + 2 * MARGIN}px`
    // beside the + when one shows in the same space, else in the middle
    close.style.left = shown ? `${((shown.x + shown.w / 2) / COLUMNS) * 100}%` : '50%'
    close.style.marginLeft = shown ? '48px' : ''
  }
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
    mark.classList.remove('is-target', 'is-hint')
    hint.hidden = true
    showStrip(null)
  }
  box.addEventListener('mousemove', event => {
    if (document.body.classList.contains('is-dragging') || document.body.classList.contains('is-resizing')) return
    if (event.target.closest?.('.grid-stack-item')) return hide()
    if (event.target.closest?.('.grid-gap, .grid-strip-close') && (shown || shownStrip)) return
    const cell = cellAt({ x: event.clientX, y: event.clientY })
    const gap = gapAt(nodes(), cell)
    shown = isRoomForCard(gap) ? gap : null
    mark.hidden = !shown
    if (shown) place(shown)
    showStrip(stripAt(nodes(), cell.y))
  })
  box.addEventListener('mouseleave', hide)
  add.addEventListener('click', () => {
    const gap = shown
    hide()
    if (gap) onAddAt?.(gap)
  })
  close.addEventListener('click', () => {
    const found = shownStrip
    hide()
    if (found) onCloseStrip?.(found)
  })
  return {
    cellAt,
    hide,
    /** The empty space a held card is over, or none: the card fills it, or it says how to. */
    target(gap, { isFilled = true, pointer = null } = {}) {
      mark.classList.toggle('is-target', Boolean(gap) && isFilled)
      mark.classList.toggle('is-hint', Boolean(gap) && !isFilled)
      mark.hidden = !gap
      if (gap) place(gap)
      hint.hidden = !gap || isFilled || !pointer
      if (!hint.hidden) {
        hint.style.left = `${pointer.x}px`
        hint.style.top = `${pointer.y}px`
      }
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
