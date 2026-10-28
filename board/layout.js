// Dragging the side panels into a new order, dragging a corner to resize them, the closed hand and
// the page scrolling at the window's edges while something is held, and the jelly wobble that goes
// with it (also when the browser window itself moves). The cards on the board sit in grid.js.

import * as L from './board-logic.js'

const LAYOUT_KEY = 'ccc.layout'
const START_DISTANCE = 6
const NOT_A_HANDLE = 'button, a, input, select, textarea, summary, .terminal, .live-reply, .chat, .chat-body, .grip'

export function loadLayout() {
  try {
    return L.normalizeLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null'))
  } catch {
    return L.normalizeLayout(null)
  }
}

export function saveLayout(layout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    // a private window: the layout lasts for this visit only
  }
}

/** The zoom the board draws at: pointers move in screen pixels, the layout is in CSS pixels. */
export function zoomOf() {
  return Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1
}

const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value))

/** A short squash-and-stretch, as if the card were made of jelly. */
export function jelly(node) {
  node.animate(
    [
      { transform: 'scale(1)' },
      { transform: 'scale(1.05, 0.95)' },
      { transform: 'scale(0.97, 1.03)' },
      { transform: 'scale(1.015, 0.985)' },
      { transform: 'scale(1)' },
    ],
    { duration: 540, easing: 'ease-out' },
  )
}

/**
 * Lets the person drag `items` inside `container` to a new place. A see-through copy follows
 * the pointer (tilting with its speed when `wobbles()`), the real one moves in the layout.
 */
// how close to the top or bottom of the window a dragged card makes the board scroll, and how fast at most
const EDGE = { reach: 72, most: 24 }

/** The page's room between the bars pinned over its top and bottom: where a dragged card is seen. */
function openRoom() {
  const bottomOf = selector => document.querySelector(selector)?.getBoundingClientRect().bottom ?? 0
  const bar = document.querySelector('.status-bar')
  return { top: Math.max(bottomOf('.taskbar'), bottomOf('#decor-top')), bottom: bar ? bar.getBoundingClientRect().top : window.innerHeight }
}

/** How fast the page scrolls with the pointer here: up near the top, down near the bottom, faster the nearer. */
export function edgeSpeed(y) {
  const room = openRoom()
  const up = room.top + EDGE.reach - y
  const down = y - (room.bottom - EDGE.reach)
  if (up > 0) return -EDGE.most * Math.min(1, up / EDGE.reach) ** 2
  if (down > 0) return EDGE.most * Math.min(1, down / EDGE.reach) ** 2
  return 0
}

/** The hand closes as the person presses on something they can drag, until they let go. */
export function holdHand() {
  document.body.classList.add('is-holding')
  const open = () => {
    document.body.classList.remove('is-holding')
    window.removeEventListener('pointerup', open)
    window.removeEventListener('pointercancel', open)
  }
  window.addEventListener('pointerup', open)
  window.addEventListener('pointercancel', open)
}

export function makeSortable(container, { items, handle, idOf, onStart, onDrop, wobbles }) {
  container.addEventListener('pointerdown', down => {
    if (down.button !== 0) return
    const item = down.target.closest(items)
    if (!item || item.parentElement !== container) return
    if (down.target.closest(NOT_A_HANDLE)) return
    if (handle && !down.target.closest(handle)) return
    holdHand()
    follow(down, item)
  })

  function follow(down, item) {
    let ghost = null
    let last = { x: down.clientX, y: down.clientY }
    let speed = { x: 0, y: 0 }
    let frame = 0

    const animate = () => {
      if (!ghost) return
      speed = { x: speed.x * 0.88, y: speed.y * 0.88 }
      ghost.node.style.transform = wobbles() ? tilt(speed) : 'scale(1.02)'
      frame = requestAnimationFrame(animate)
    }

    const move = event => {
      if (!ghost) {
        if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < START_DISTANCE) return
        ghost = lift(item, down)
        onStart?.()
        document.body.classList.add('is-dragging')
        frame = requestAnimationFrame(animate)
      }
      speed = { x: speed.x * 0.6 + (event.clientX - last.x) * 0.4, y: speed.y * 0.6 + (event.clientY - last.y) * 0.4 }
      last = { x: event.clientX, y: event.clientY }
      place(ghost, event)
      reorder(container, item, items, event)
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      cancelAnimationFrame(frame)
      if (!ghost) return
      document.body.classList.remove('is-dragging')
      settle(ghost, item, wobbles())
      onDrop([...container.children].filter(node => node.matches(items)).map(idOf))
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
}

function tilt(speed) {
  return `rotate(${clamp(speed.x * 0.5, 9)}deg) skew(${clamp(-speed.x * 0.7, 14)}deg, ${clamp(speed.y * 0.35, 6)}deg) scale(1.03)`
}

function lift(item, down) {
  const zoom = zoomOf()
  const rect = item.getBoundingClientRect()
  const node = item.dataset.ghost === 'light' ? lightCopy(item) : item.cloneNode(true)
  node.querySelectorAll('[id]').forEach(child => child.removeAttribute('id'))
  node.removeAttribute('id')
  node.classList.add('drag-ghost')
  node.setAttribute('aria-hidden', 'true')
  node.style.zoom = zoom
  node.style.width = `${rect.width / zoom}px`
  node.style.height = `${rect.height / zoom}px`
  const offset = { x: down.clientX - rect.left, y: down.clientY - rect.top }
  node.style.transformOrigin = `${offset.x / zoom}px ${offset.y / zoom}px`
  document.body.append(node)
  item.classList.add('drag-source')
  const ghost = { node, offset, zoom }
  place(ghost, down)
  return ghost
}

/**
 * A copy of a big card for dragging: its frame and its first part (the title bar) only. A whole
 * copy of a chat would start its history over from the top and lay old lines over the board.
 */
function lightCopy(item) {
  const node = item.cloneNode(false)
  if (item.firstElementChild) node.append(item.firstElementChild.cloneNode(true))
  return node
}

function place(ghost, event) {
  ghost.node.style.left = `${(event.clientX - ghost.offset.x) / ghost.zoom}px`
  ghost.node.style.top = `${(event.clientY - ghost.offset.y) / ghost.zoom}px`
}

/** Moves the real item next to whichever sibling the pointer is over. */
function reorder(container, item, items, event) {
  for (const sibling of container.children) {
    if (sibling === item || !sibling.matches(items)) continue
    const r = sibling.getBoundingClientRect()
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) continue
    const before = event.clientX < r.left + r.width / 2
    if (before && sibling.previousElementSibling !== item) container.insertBefore(item, sibling)
    if (!before && sibling.nextElementSibling !== item) container.insertBefore(item, sibling.nextElementSibling)
    return
  }
}

function settle(ghost, item, wobble) {
  const rect = item.getBoundingClientRect()
  const node = ghost.node
  node.style.transition = 'left 0.22s ease, top 0.22s ease, transform 0.22s ease'
  node.style.left = `${rect.left / ghost.zoom}px`
  node.style.top = `${rect.top / ghost.zoom}px`
  node.style.transform = 'none'
  setTimeout(() => {
    node.remove()
    item.classList.remove('drag-source')
    if (wobble) jelly(item)
  }, 230)
}

/**
 * Lets the person drag an item's grips (its corners and edges) to make it bigger or smaller.
 * `onResize(item, size, isDone)` gets, in CSS pixels, the size the grip makes (`width`, `height`)
 * and how far it was pulled (`dx`, `dy`) with which grip (`axis`), while dragging and once at the end.
 */
export function makeResizable(container, { items, onStart, onResize, wobbles }) {
  container.addEventListener('pointerdown', down => {
    const grip = down.target.closest('.grip')
    const item = grip?.closest(items)
    if (!item || item.parentElement !== container) return
    down.preventDefault()
    down.stopPropagation()
    const zoom = zoomOf()
    const rect = item.getBoundingClientRect()
    // an edge grip moves one side, a corner grip two; a left or top one grows pulled away from the card
    const axis = grip.dataset.axis
    const sizeAt = event => {
      const dx = (event.clientX - down.clientX) / zoom
      const dy = (event.clientY - down.clientY) / zoom
      const growth = L.gripGrowth(axis, dx, dy)
      return { width: rect.width / zoom + growth.width, height: rect.height / zoom + growth.height, dx, dy, axis }
    }
    onStart?.(item)
    document.body.classList.add('is-resizing')
    const move = event => onResize(item, sizeAt(event), false)
    const up = event => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      document.body.classList.remove('is-resizing')
      onResize(item, sizeAt(event), true)
      if (wobbles()) jelly(item)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  })
}

/**
 * When the browser window moves, every glass panel lags behind on a spring and settles,
 * like the wobbly windows of old desktops. Only while `isOn()`.
 */
export function watchWindowMoves(isOn) {
  let lastX = window.screenX
  let lastY = window.screenY
  const springs = new Map()
  const quietUntil = performance.now() + 800
  const step = now => {
    const dx = window.screenX - lastX
    const dy = window.screenY - lastY
    lastX = window.screenX
    lastY = window.screenY
    const isJump = Math.abs(dx) > 200 || Math.abs(dy) > 200
    if (isOn() && (dx || dy) && !isJump && now > quietUntil) {
      document.querySelectorAll('.content .glass').forEach((panel, i) => {
        const spring = springs.get(panel) ?? { x: 0, y: 0, vx: 0, vy: 0 }
        const lag = 0.6 + (i % 5) * 0.12
        spring.vx -= clamp(dx, 60) * 9 * lag
        spring.vy -= clamp(dy, 60) * 9 * lag
        springs.set(panel, spring)
      })
    }
    for (const [panel, s] of springs) {
      s.vx += (-120 * s.x - 9 * s.vx) / 60
      s.vy += (-120 * s.y - 9 * s.vy) / 60
      s.x += s.vx / 60
      s.y += s.vy / 60
      const isStill = Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.vx) + Math.abs(s.vy) < 0.2
      if (isStill || !panel.isConnected) {
        panel.style.transform = ''
        springs.delete(panel)
        continue
      }
      panel.style.transform = `translate(${clamp(s.x, 18)}px, ${clamp(s.y, 18)}px) skew(${clamp(s.x * 0.4, 6)}deg, ${clamp(s.y * 0.2, 3)}deg)`
    }
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}
