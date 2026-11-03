// A card's artifacts: the pages Claude published in the session with the Artifact tool, shown beside
// the chat as live pages to use, as the Claude app shows them at its side. Each is its own file on
// this Mac, walled off from the board (the server marks it so too). What needs claude.ai itself
// (data kept for its viewers, files people add, asking Claude) works there: "Open on claude.ai".

import { newestFirst } from './chat-logic.js'

const SVG = 'http://www.w3.org/2000/svg'
// what a page may do in its wall: the same the server allows it
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals'

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (name === 'class') node.className = value
    else node.setAttribute(name, value === true ? '' : value)
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child)
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

/**
 * Makes the artifact view of one card: `pane` is where it draws, `onClose` puts the card back to its
 * chat alone. With `only` (an artifact's number) it shows that one, with no list to pick from and no
 * close of its own (its card has one). Returns `show(summary)`, to call whenever the board's data
 * comes, and `stop()`.
 */
export function artifactPane(pane, sessionId, { onClose, only = null }) {
  const state = { artifacts: [], chosen: only, at: -1, shownAt: -1, isLoading: false, isStopped: false }
  const picker = el('select', { class: 'artifact-picker', 'aria-label': 'Which artifact' })
  const title = el('span', { class: 'artifact-title' })
  const reload = el('button', { type: 'button', class: 'artifact-button', title: 'Load the page again' }, icon('M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3'))
  const open = el('a', { class: 'artifact-button artifact-open', target: '_blank', rel: 'noopener noreferrer', title: 'Open it on claude.ai, where what it keeps for its viewers works too' }, 'Open on claude.ai', icon('M9 2h5v5M14 2 7 9', 11))
  const close = el('button', { type: 'button', class: 'artifact-button artifact-close', 'aria-label': 'Close the artifact', title: 'Close the artifact: the card goes back to its own size' }, icon('M4 4l8 8M12 4l-8 8'))
  const place = el('div', { class: 'artifact-place' })
  pane.replaceChildren(el('div', { class: 'artifact-bar' }, picker, title, el('span', { class: 'artifact-tools' }, reload, open, only === null ? close : null)), place)

  picker.addEventListener('change', () => {
    state.chosen = Number(picker.value)
    state.shownAt = -1
    draw()
  })
  reload.addEventListener('click', () => {
    state.shownAt = -1
    draw()
  })
  close.addEventListener('click', () => onClose())

  async function load() {
    state.isLoading = true
    try {
      const response = await fetch(`/api/artifacts?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
      if (response.ok) state.artifacts = newestFirst((await response.json()).artifacts ?? [])
    } catch {
      // the board's server is away for a moment: the next look tries again
    } finally {
      state.isLoading = false
    }
    if (!state.isStopped) draw()
  }

  function draw() {
    const shown = state.artifacts.find(one => one.id === state.chosen) ?? (only === null ? state.artifacts[0] : null)
    picker.hidden = only !== null || state.artifacts.length < 2
    picker.replaceChildren(...state.artifacts.map(one => el('option', { value: String(one.id), selected: one === shown }, one.title)))
    // a card of its own has the title in its header already
    title.hidden = !picker.hidden || only !== null
    title.textContent = shown?.title ?? ''
    open.hidden = !shown
    if (shown) open.href = shown.url
    if (!shown) {
      place.replaceChildren(el('p', { class: 'artifact-note' }, only === null ? 'Nothing published in this session yet.' : 'Claude deleted this artifact.'))
      return
    }
    state.chosen = shown.id
    if (!shown.isHere) {
      state.shownAt = -1
      place.replaceChildren(el('p', { class: 'artifact-note' }, 'Its page is not on this Mac any more. It still is on claude.ai.'))
      return
    }
    // a page that changed since (Claude published it again) is loaded again; one that did not stays as it is
    if (state.shownAt === shown.at && place.querySelector('iframe')) return
    state.shownAt = shown.at
    place.replaceChildren(el('iframe', { class: 'artifact-frame', src: `/artifact/${encodeURIComponent(sessionId)}/${shown.id}/?v=${shown.at}`, sandbox: SANDBOX, title: shown.title, allow: 'autoplay; clipboard-write; fullscreen' }))
  }

  return {
    show(summary) {
      if (!summary || state.isLoading || summary.at === state.at) return
      state.at = summary.at
      load()
    },
    stop() {
      state.isStopped = true
      pane.replaceChildren()
    },
  }
}

// the grips a card is resized by, as every card on the board has them
const GRIPS = [['grip grip-x', 'x'], ['grip grip-y', 'y'], ['grip', null], ['grip grip-bl', 'corner-bl'], ['grip grip-tr', 'corner-tr'], ['grip grip-tl', 'corner-tl']]

/**
 * An artifact as a card of its own on the board, opened from "+": its page to use, under a header
 * the card is moved by. `card` is { id, sessionId, index, title, sessionTitle }; `onClose` takes it off
 * the board. Returns { root, show(summary), stop() }: `show` with its session's summary, when that
 * session is on the board, loads the page again once Claude published it again.
 */
export function artifactCard(card, { onClose }) {
  const close = el('button', { type: 'button', class: 'chat-close chat-remove', 'aria-label': `Close ${card.title}`, title: 'Close this artifact' }, icon('M4 4l8 8M12 4l-8 8'))
  close.addEventListener('click', () => onClose())
  const head = el(
    'header',
    { class: 'chat-head artifact-head' },
    el('span', { class: 'artifact-glyph', 'aria-hidden': 'true' }, icon('M2.5 3h11v10h-11zM8.5 3v10M10.5 6h1M10.5 8.5h1')),
    el('span', { class: 'chat-title' }, card.title),
    el('span', { class: 'source source-artifact' }, 'Artifact'),
    el('span', { class: 'chat-where', title: `Published in ${card.sessionTitle}` }, card.sessionTitle ?? ''),
    close,
  )
  const place = el('div', { class: 'chat-artifact artifact-card-body' })
  const root = el('article', { class: 'glass tile expanded-tile artifact-tile', 'data-session': card.id, 'data-ghost': 'light', 'aria-label': `Artifact: ${card.title}` }, head, place, ...GRIPS.map(([name, axis]) => el('span', { class: name, 'data-axis': axis, 'aria-hidden': 'true' })))
  const pane = artifactPane(place, card.sessionId, { onClose, only: card.index })
  pane.show({ at: 0 })
  return { root, show: summary => summary && pane.show(summary), stop: () => pane.stop() }
}
