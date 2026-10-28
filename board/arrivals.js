// How a new session's card comes onto the board, in each theme's own way: shot up out of a
// volcano in Inferno, carried in a soap bubble in Aero, glitched in as a hologram in Neon City,
// beamed down in Deep Space, called in with an emergency alert in Evangelion, zoomed open like a
// window in Windows XP and 98, locked on by a scanner and glitched in in Cyberpunk 2077, loaded from
// tape on the ZX Spectrum, popped up out of the Dock in macOS, and a quiet rise in Clean. The card
// plays it on its own spot.

import { jelly } from './layout.js'
import { eruptNear, infernoVolcanoes } from './themes.js'

/** Plays the theme's arrival on a card that has just been placed. */
export function welcome(node, themeId) {
  const rect = node?.getBoundingClientRect()
  if (!rect?.width || !node.offsetWidth) return
  const zoom = rect.width / node.offsetWidth
  const play = ARRIVALS[themeId] ?? ARRIVALS.clean
  node.classList.add('arriving')
  const animation = play(node, rect, zoom)
  const done = () => node.classList.remove('arriving')
  if (animation) animation.finished.then(done, done)
  else done()
}

/** The crater straight below a card, or the nearest one beside it. */
export function nearestCrater(craters, x) {
  return craters.reduce((best, crater) => (Math.abs(crater.x - x) < Math.abs(best.x - x) ? crater : best))
}

// ---------- the looks ----------

const ARRIVALS = {
  inferno(node, rect, zoom) {
    const middle = centreOf(rect)
    const craters = infernoVolcanoes(window.innerWidth, window.innerHeight).map(v => ({ x: v.x, y: window.innerHeight - v.height }))
    const crater = nearestCrater(craters, middle.x)
    const dx = (crater.x - middle.x) / zoom
    const dy = (crater.y - middle.y) / zoom
    eruptNear(crater.x)
    setTimeout(() => burst(rect, 'arrival-ember', 22, { spread: rect.width, rise: 160 }), 1350)
    return node.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(0.08) rotate(-35deg)`, opacity: 0, filter: 'brightness(2.4) drop-shadow(0 0 30px #ff6a1f)' },
        { transform: `translate(${dx}px, ${dy - 40 / zoom}px) scale(0.22) rotate(-20deg)`, opacity: 1, offset: 0.14 },
        { transform: `translate(${dx * 0.35}px, ${Math.min(dy, 0) * 0.35 - 200 / zoom}px) scale(0.75) rotate(12deg)`, filter: 'brightness(1.6) drop-shadow(0 0 22px #ff6a1f)', offset: 0.6 },
        { transform: 'translate(0, -14px) scale(1.04) rotate(-2deg)', filter: 'brightness(1.15) drop-shadow(0 0 12px #ff6a1f)', offset: 0.86 },
        { transform: 'none', opacity: 1, filter: 'none' },
      ],
      { duration: 1700, easing: 'cubic-bezier(.3,.6,.4,1)' },
    )
  },

  aero(node, rect, zoom) {
    const middle = centreOf(rect)
    const size = Math.max(150, rect.width * 0.62)
    const from = { x: middle.x + 70, y: window.innerHeight + size }
    const bubble = overlay('arrival-bubble', { width: size, height: size })
    const path = (x, y, scale) => `translate(${x - size / 2}px, ${y - size / 2}px) scale(${scale})`
    bubble.animate(
      [
        { transform: path(from.x, from.y, 0.6) },
        { transform: path(lerp(from.x, middle.x, 0.5) - 40, lerp(from.y, middle.y, 0.55), 0.85), offset: 0.5 },
        { transform: path(middle.x, middle.y, 1) },
      ],
      { duration: 1300, easing: 'cubic-bezier(.25,.7,.4,1)', fill: 'forwards' },
    )
    setTimeout(() => {
      bubble.animate([{ opacity: 1, transform: path(middle.x, middle.y, 1) }, { opacity: 0, transform: path(middle.x, middle.y, 1.7) }], { duration: 260, fill: 'forwards' })
      burst(rect, 'arrival-drop', 14, { spread: size, rise: 40 })
      jelly(node)
      setTimeout(() => bubble.parentNode?.remove(), 400)
    }, 1300)
    const dx = (from.x - middle.x) / zoom
    const dy = (from.y - middle.y) / zoom
    return node.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(0.32)`, opacity: 0.9 },
        { transform: `translate(${dx * 0.5 - 40 / zoom}px, ${dy * 0.45}px) scale(0.36) rotate(-6deg)`, offset: 0.5 },
        { transform: 'translate(0, 0) scale(0.4) rotate(3deg)', offset: 0.97 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 1340, easing: 'cubic-bezier(.25,.7,.4,1)' },
    )
  },

  neon(node, rect) {
    const scan = overlay('arrival-scan', { width: rect.width, height: 3 })
    scan.animate([{ transform: `translate(${rect.left}px, ${rect.top}px)`, opacity: 1 }, { transform: `translate(${rect.left}px, ${rect.bottom}px)`, opacity: 0.2 }], {
      duration: 700,
      delay: 250,
      easing: 'linear',
      fill: 'both',
    })
    setTimeout(() => scan.parentNode?.remove(), 1100)
    return node.animate(
      [
        { clipPath: 'inset(49% 0 49% 0)', filter: 'brightness(3) saturate(0)', transform: 'skewX(-14deg)', opacity: 0.2 },
        { clipPath: 'inset(49% 0 49% 0)', filter: 'brightness(3) hue-rotate(90deg)', transform: 'skewX(10deg)', opacity: 1, offset: 0.18 },
        { clipPath: 'inset(0 0 0 0)', filter: 'brightness(1.8) hue-rotate(-60deg)', transform: 'translateX(-8px)', offset: 0.42 },
        { clipPath: 'inset(12% 0 30% 0)', filter: 'brightness(1.4) hue-rotate(40deg)', transform: 'translateX(6px)', offset: 0.52 },
        { clipPath: 'inset(0 0 0 0)', filter: 'brightness(1.2)', transform: 'translateX(-3px)', offset: 0.62 },
        { clipPath: 'inset(0 0 0 0)', filter: 'brightness(1)', transform: 'translateX(2px)', offset: 0.75 },
        { clipPath: 'inset(0 0 0 0)', filter: 'none', transform: 'none', opacity: 1 },
      ],
      { duration: 1100, easing: 'linear' },
    )
  },

  space(node, rect) {
    const middle = centreOf(rect)
    const width = Math.min(160, rect.width * 0.6)
    const beam = overlay('arrival-beam', { width, height: rect.bottom })
    beam.style.transform = `translateX(${middle.x - width / 2}px)`
    beam.animate([{ opacity: 0, transform: `translateX(${middle.x - width / 2}px) scaleX(0.1)` }, { opacity: 1, transform: `translateX(${middle.x - width / 2}px) scaleX(1)`, offset: 0.35 }, { opacity: 0, transform: `translateX(${middle.x - width / 2}px) scaleX(0.05)` }], {
      duration: 1300,
      easing: 'ease-in-out',
      fill: 'forwards',
    })
    setTimeout(() => beam.parentNode?.remove(), 1400)
    setTimeout(() => burst(rect, 'arrival-star', 18, { spread: rect.width * 1.1, rise: 30, twinkle: true }), 650)
    return node.animate(
      [
        { transform: 'scale(0.6, 0.02)', filter: 'brightness(4)', opacity: 0 },
        { transform: 'scale(1, 0.02)', filter: 'brightness(4)', opacity: 1, offset: 0.35 },
        { transform: 'scale(1, 1.05)', filter: 'brightness(1.6)', offset: 0.72 },
        { transform: 'none', filter: 'none', opacity: 1 },
      ],
      { duration: 1250, easing: 'ease-out' },
    )
  },

  eva(node, rect) {
    alertFrame(rect, 'arrival-alert', 'EMERGENCY')
    return node.animate(
      [
        { clipPath: 'inset(0 50% 0 50%)', filter: 'brightness(2.4) sepia(1) hue-rotate(-20deg) saturate(3)', opacity: 0 },
        { clipPath: 'inset(0 50% 0 50%)', filter: 'brightness(2.4) sepia(1) hue-rotate(-20deg) saturate(3)', opacity: 1, offset: 0.2 },
        { clipPath: 'inset(0 0 0 0)', filter: 'brightness(1.6) sepia(0.6) hue-rotate(-20deg) saturate(2)', offset: 0.5 },
        { clipPath: 'inset(0 0 0 0)', filter: 'brightness(1.2)', offset: 0.75 },
        { clipPath: 'inset(0 0 0 0)', filter: 'none', opacity: 1 },
      ],
      { duration: 1200, easing: 'cubic-bezier(.2,.8,.3,1)' },
    )
  },

  // Windows XP: the outline of a window zooms out to the card's place, and the card is there
  xp(node, rect) {
    return windowZoom(node, rect, 'arrival-xp-frame')
  },

  // Cyberpunk 2077: a scanner's four corner marks close in on the card's spot and lock on, with its
  // tag above; the card glitches in, torn sideways in slices, its colours split
  cyberpunk(node, rect) {
    const frame = overlay('arrival-cp-frame', { width: rect.width, height: rect.height })
    const tag = document.createElement('span')
    tag.className = 'arrival-cp-tag'
    tag.textContent = 'NEW JOB // SCANNING'
    frame.append(tag)
    frame.animate(
      [
        { transform: `translate(${rect.left - 40}px, ${rect.top - 40}px)`, width: `${rect.width + 80}px`, height: `${rect.height + 80}px`, opacity: 0 },
        { transform: `translate(${rect.left - 40}px, ${rect.top - 40}px)`, width: `${rect.width + 80}px`, height: `${rect.height + 80}px`, opacity: 1, offset: 0.15 },
        { transform: `translate(${rect.left}px, ${rect.top}px)`, width: `${rect.width}px`, height: `${rect.height}px`, opacity: 1, offset: 0.5 },
        { transform: `translate(${rect.left}px, ${rect.top}px)`, width: `${rect.width}px`, height: `${rect.height}px`, opacity: 1, offset: 0.85 },
        { transform: `translate(${rect.left}px, ${rect.top}px)`, width: `${rect.width}px`, height: `${rect.height}px`, opacity: 0 },
      ],
      { duration: 900, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' },
    )
    setTimeout(() => frame.parentNode?.remove(), 1000)
    return node.animate(
      [
        { opacity: 0, clipPath: 'inset(0 0 100% 0)' },
        { opacity: 0, clipPath: 'inset(0 0 100% 0)', offset: 0.4 },
        { opacity: 1, clipPath: 'inset(0 0 62% 0)', transform: 'translateX(-10px)', filter: 'drop-shadow(4px 0 #5ef6ff) drop-shadow(-4px 0 #f75049)', offset: 0.48 },
        { opacity: 1, clipPath: 'inset(30% 0 22% 0)', transform: 'translateX(8px)', filter: 'drop-shadow(-3px 0 #5ef6ff) drop-shadow(3px 0 #f75049)', offset: 0.56 },
        { opacity: 1, clipPath: 'inset(0 0 0 0)', transform: 'translateX(-4px)', filter: 'drop-shadow(2px 0 #5ef6ff) drop-shadow(-2px 0 #f75049)', offset: 0.64 },
        { opacity: 0.6, clipPath: 'inset(55% 0 0 0)', transform: 'translateX(3px)', offset: 0.7 },
        { opacity: 1, clipPath: 'inset(0 0 0 0)', transform: 'none', filter: 'none', offset: 0.78 },
        { opacity: 1, clipPath: 'inset(0 0 0 0)', transform: 'none', filter: 'none' },
      ],
      { duration: 900, easing: 'steps(1, end)' },
    )
  },

  // Windows 98: the same zooming outline, square and grey with a navy title bar
  win98(node, rect) {
    return windowZoom(node, rect, 'arrival-win98-frame')
  },

  // macOS: it springs up out of the Dock at the bottom, the way a window opens there
  macos(node) {
    return node.animate(
      [
        { transform: 'translateY(60px) scale(0.6)', opacity: 0, transformOrigin: '50% 100%' },
        { transform: 'translateY(-6px) scale(1.02)', opacity: 1, offset: 0.7, transformOrigin: '50% 100%' },
        { transform: 'none', opacity: 1, transformOrigin: '50% 100%' },
      ],
      { duration: 620, easing: 'cubic-bezier(.2,.8,.3,1)' },
    )
  },

  // ZX Spectrum: loaded from tape, the stripes flashing round its place, the card coming in in lines
  spectrum(node, rect) {
    const frame = overlay('arrival-tape', { width: rect.width + 24, height: rect.height + 24 })
    frame.style.transform = `translate(${rect.left - 12}px, ${rect.top - 12}px)`
    frame.animate([{ opacity: 1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }], { duration: 1100, fill: 'both' })
    setTimeout(() => frame.parentNode?.remove(), 1200)
    const steps = [0, 12, 25, 37, 50, 62, 75, 87, 100].map((shown, i, all) => ({ clipPath: `inset(0 0 ${100 - shown}% 0)`, offset: i / (all.length - 1), easing: 'steps(1, end)' }))
    return node.animate(steps, { duration: 1000 })
  },

  clean(node) {
    return node.animate(
      [
        { transform: 'translateY(24px) scale(0.97)', opacity: 0, boxShadow: '0 0 0 0 rgba(70, 110, 190, 0)' },
        { transform: 'none', opacity: 1, boxShadow: '0 0 0 6px rgba(70, 110, 190, 0.22)', offset: 0.6 },
        { transform: 'none', opacity: 1, boxShadow: '0 0 0 0 rgba(70, 110, 190, 0)' },
      ],
      { duration: 900, easing: 'ease-out' },
    )
  },
}

// ---------- small pieces ----------

const lerp = (a, b, u) => a + (b - a) * u

function centreOf(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

/** A thing drawn over the whole page for the length of an arrival. */
function overlay(className, { width, height }) {
  const layer = document.createElement('div')
  layer.className = 'arrival-layer'
  layer.setAttribute('aria-hidden', 'true')
  const piece = document.createElement('div')
  piece.className = className
  piece.style.width = `${width}px`
  piece.style.height = `${height}px`
  layer.append(piece)
  document.body.append(layer)
  return piece
}

/** A frame flashing round the card's spot, with a tag on its top edge. */
/** A window's outline zooms out from the middle of the card's place to its full size, and the card is there. */
function windowZoom(node, rect, className) {
  const middle = centreOf(rect)
  const frame = overlay(className, { width: rect.width, height: rect.height })
  frame.animate(
    [
      { transform: `translate(${middle.x - rect.width / 2}px, ${middle.y - rect.height / 2}px) scale(0.08)`, opacity: 1 },
      { transform: `translate(${rect.left}px, ${rect.top}px) scale(1)`, opacity: 1, offset: 0.85 },
      { transform: `translate(${rect.left}px, ${rect.top}px) scale(1)`, opacity: 0 },
    ],
    { duration: 330, easing: 'ease-out', fill: 'both' },
  )
  setTimeout(() => frame.parentNode?.remove(), 400)
  return node.animate([{ opacity: 0 }, { opacity: 0, offset: 0.55 }, { opacity: 1 }], { duration: 480, easing: 'linear' })
}

function alertFrame(rect, className, words) {
  const frame = overlay(className, { width: rect.width + 16, height: rect.height + 16 })
  frame.style.transform = `translate(${rect.left - 8}px, ${rect.top - 8}px)`
  const label = document.createElement('span')
  label.className = 'arrival-alert-label'
  label.textContent = words
  frame.append(label)
  // each step holds until the next, so the frame flashes on and off rather than fading
  const flashes = [0, 1, 0.2, 1, 0.2, 1, 1, 0].map((opacity, i, all) => ({ opacity, offset: i / (all.length - 1), easing: 'steps(1, end)' }))
  frame.animate(flashes, { duration: 1300, fill: 'both' })
  setTimeout(() => frame.parentNode?.remove(), 1400)
}

/** Sparks, drops or stars flying out from the card's lower edge. */
function burst(rect, className, count, { spread, rise, twinkle = false }) {
  const layer = document.createElement('div')
  layer.className = 'arrival-layer'
  layer.setAttribute('aria-hidden', 'true')
  document.body.append(layer)
  const origin = { x: rect.left + rect.width / 2, y: twinkle ? rect.top + rect.height / 2 : rect.bottom }
  for (let i = 0; i < count; i += 1) {
    const piece = document.createElement('div')
    piece.className = className
    piece.style.left = `${origin.x + (twinkle ? (Math.random() - 0.5) * spread : 0)}px`
    piece.style.top = `${origin.y + (twinkle ? (Math.random() - 0.5) * rect.height : 0)}px`
    layer.append(piece)
    const dx = twinkle ? 0 : (Math.random() - 0.5) * spread
    const up = rise * (0.5 + Math.random())
    piece.animate(
      [
        { transform: 'translate(0, 0) scale(0.4)', opacity: 0 },
        { transform: `translate(${dx * 0.6}px, ${-up}px) scale(1)`, opacity: 1, offset: 0.35 },
        { transform: `translate(${dx}px, ${-up * 0.4}px) scale(0.2)`, opacity: 0 },
      ],
      { duration: 800 + Math.random() * 600, delay: twinkle ? Math.random() * 300 : 0, easing: 'ease-out', fill: 'both' },
    )
  }
  setTimeout(() => layer.remove(), 1800)
}
