// A card's Design tab: the screens Claude made with Claude Design, laid out as its canvas places
// them and scaled to the card, each a live page; one click shows a screen large. The canvas's own
// tools (panning, comments, sharing) stay in Claude: "Open the canvas" goes there. claude.ai does
// not let its canvas be shown inside another page, so the board shows the screens' own files.

import { designLayout, designScale } from './chat-logic.js'

const SVG = 'http://www.w3.org/2000/svg'

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (name === 'class') node.className = value
    else node.setAttribute(name, value === true ? '' : value)
  }
  for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child)
  return node
}

function icon(d, size = 13) {
  const node = document.createElementNS(SVG, 'svg')
  node.setAttribute('viewBox', '0 0 16 16')
  node.setAttribute('width', String(size))
  node.setAttribute('height', String(size))
  node.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG, 'path')
  path.setAttribute('d', d)
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.6')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  node.append(path)
  return node
}

/** A screen's own page, walled off from the board (the server marks it so too), at its own size. */
function screenFrame(sessionId, design, screen) {
  return el('iframe', {
    class: 'design-frame',
    src: `/design/${encodeURIComponent(sessionId)}/${design.id}/${encodeURIComponent(screen.file)}?v=${screen.at}`,
    sandbox: 'allow-scripts',
    title: screen.title,
    width: String(screen.w),
    height: String(screen.h),
    loading: 'lazy',
    tabindex: '-1',
  })
}

/**
 * Makes the Design tab of one card: `pane` is where it draws, `onBack` goes back to the chat.
 * Returns `show(summary)`, to call whenever the board's data comes, and `stop()`.
 */
export function designTab(pane, sessionId, { onBack }) {
  const state = { designs: [], chosen: null, focus: null, at: -1, isLoading: false }
  // each screen's page, kept while it is unchanged: drawn again at another size, it is not loaded again
  const frames = new Map()
  const frameOf = (shown, screen) => {
    const key = `${shown.id}/${screen.file}/${screen.at}`
    if (!frames.has(key)) frames.set(key, screenFrame(sessionId, shown, screen))
    return frames.get(key)
  }
  const canvas = el('div', { class: 'design-canvas' })
  const title = el('strong', { class: 'design-title' })
  const count = el('span', { class: 'design-count' })
  const picker = el('select', { class: 'design-picker', 'aria-label': 'Design', hidden: true })
  const open = el('a', { class: 'design-open', target: '_blank', rel: 'noopener', hidden: true, title: 'The canvas itself, in Claude: panning, comments and sharing' }, 'Open the canvas', icon('M9 2h5v5M14 2 7 9', 11))
  const back = el('button', { type: 'button', class: 'design-back' }, 'Back to the chat')
  back.addEventListener('click', onBack)
  picker.addEventListener('change', () => {
    state.chosen = Number(picker.value)
    state.focus = null
    draw()
  })
  pane.replaceChildren(el('div', { class: 'design-bar' }, title, count, picker, el('span', { class: 'design-spacer' }), open, back), canvas)

  const design = () => state.designs.find(one => one.id === state.chosen) ?? state.designs.at(-1)

  // the canvas, or one screen, scaled to the room the card gives it; drawn again as the card resizes
  function draw() {
    const shown = design()
    title.textContent = shown?.title ?? 'Design'
    count.textContent = shown ? `${shown.screens.length} screen${shown.screens.length === 1 ? '' : 's'}` : ''
    open.hidden = !shown?.url
    if (shown?.url) open.href = shown.url
    picker.hidden = state.designs.length < 2
    picker.replaceChildren(...state.designs.map(one => el('option', { value: String(one.id), selected: one === shown }, one.title)))
    if (!shown) {
      canvas.replaceChildren(el('p', { class: 'design-empty' }, state.isLoading ? 'Loading the design…' : 'No screens of this design are on this Mac.'))
      return
    }
    const room = { w: canvas.clientWidth, h: canvas.clientHeight }
    if (room.w < 40 || room.h < 40) return
    const focused = shown.screens.find(screen => screen.file === state.focus)
    if (focused) return drawFocus(shown, focused, room)
    const layout = designLayout(shown)
    const scale = designScale(layout, room)
    const board = el('div', { class: 'design-board', style: `width:${Math.round(layout.w * scale)}px;height:${Math.round(layout.h * scale)}px` })
    for (const note of layout.notes) {
      board.append(el('div', { class: 'design-note', style: `left:${note.x * scale}px;top:${note.y * scale}px` }, note.text))
    }
    for (const screen of layout.screens) {
      const frame = frameOf(shown, screen)
      frame.setAttribute('tabindex', '-1')
      frame.style.transform = `scale(${scale})`
      const tile = el(
        'button',
        { type: 'button', class: 'design-screen', title: `${screen.title}: show it large`, style: `left:${screen.x * scale}px;top:${screen.y * scale}px;width:${screen.w * scale}px;height:${screen.h * scale}px` },
        frame,
      )
      tile.addEventListener('click', () => {
        state.focus = screen.file
        draw()
      })
      board.append(tile, el('div', { class: 'design-label', style: `left:${screen.x * scale}px;top:${screen.y * scale - 18}px;width:${screen.w * scale}px` }, screen.title))
    }
    canvas.replaceChildren(board)
  }

  // one screen as large as the card allows, with the ones before and after it a click away
  function drawFocus(shown, screen, room) {
    const at = shown.screens.indexOf(screen)
    const step = by => {
      const next = shown.screens[(at + by + shown.screens.length) % shown.screens.length]
      state.focus = next.file
      draw()
    }
    const bar = el('div', { class: 'design-focus-bar' })
    const all = el('button', { type: 'button', class: 'design-step' }, icon('M10 3 5 8l5 5'), 'All screens')
    all.addEventListener('click', () => {
      state.focus = null
      draw()
    })
    const before = el('button', { type: 'button', class: 'design-step', 'aria-label': 'The screen before', disabled: shown.screens.length < 2 }, '‹')
    const after = el('button', { type: 'button', class: 'design-step', 'aria-label': 'The screen after', disabled: shown.screens.length < 2 }, '›')
    before.addEventListener('click', () => step(-1))
    after.addEventListener('click', () => step(1))
    bar.append(all, el('span', { class: 'design-focus-title' }, screen.title), before, el('span', { class: 'design-count' }, `${at + 1} of ${shown.screens.length}`), after)
    const scale = Math.min(1, (room.w - 24) / screen.w, (room.h - 56) / screen.h)
    const frame = frameOf(shown, screen)
    frame.style.transform = `scale(${scale})`
    // a screen shown large takes the pointer: buttons and menus in it work as the page has them
    frame.removeAttribute('tabindex')
    canvas.replaceChildren(bar, el('div', { class: 'design-focus', style: `width:${screen.w * scale}px;height:${screen.h * scale}px` }, frame))
  }

  async function load() {
    state.isLoading = true
    try {
      const response = await fetch(`/api/design?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
      const data = response.ok ? await response.json() : { designs: [] }
      state.designs = Array.isArray(data.designs) ? data.designs : []
      // pages of screens that changed since go
      const kept = new Set(state.designs.flatMap(one => one.screens.map(screen => `${one.id}/${screen.file}/${screen.at}`)))
      for (const key of frames.keys()) if (!kept.has(key)) frames.delete(key)
    } catch {
      // the board is not running: what was shown stays
    } finally {
      state.isLoading = false
    }
    draw()
  }

  const resized = new ResizeObserver(() => draw())
  resized.observe(canvas)
  return {
    /** The board's data came: a screen that changed is loaded again, as Claude works on it. */
    show(summary) {
      const at = summary?.at ?? 0
      if (at === state.at) return
      state.at = at
      load()
    },
    stop() {
      resized.disconnect()
    },
  }
}
