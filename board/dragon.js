// Inferno's send-off for a card the person removes: a dragon swoops down, takes the card in its
// claws, carries it away over a volcano and drops it into the crater, which erupts. The flight is
// planned first (planFlight, plain numbers a test can check), then played on copies of the card.

import { eruptNear, infernoVolcanoes } from './themes.js'

/** Where the claws hold, in the dragon's own drawing (280 × 200, facing right). */
const CLAW = { x: 150, y: 156 }
/** The longest a card is while carried, in screen pixels: a big card is held smaller. */
const CARRIED_WIDTH = 300
/** How big the dragon is drawn, beside how near it is. */
const DRAGON_SCALE = 1.3
const STEP_MS = 30
const PHASES = { swoop: 1150, grab: 350, carry: 1700, drop: 800, exit: 1100 }
/** What covers a crater on the page, so the dragon picks one that shows. */
const COVERS = '.glass, .taskbar, .doom-bar, .decor-top > *, dialog'

// ---------- the plan: where the dragon and the card are at each moment ----------

const ease = {
  out: u => 1 - (1 - u) ** 3,
  in: u => u * u,
  inOut: u => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2),
}

const lerp = (a, b, u) => a + (b - a) * u
const clampTo = (value, low, high) => Math.min(high, Math.max(low, value))

function bezier(p0, p1, p2, p3, u) {
  const v = 1 - u
  return {
    x: v ** 3 * p0.x + 3 * v * v * u * p1.x + 3 * v * u * u * p2.x + u ** 3 * p3.x,
    y: v ** 3 * p0.y + 3 * v * v * u * p1.y + 3 * v * u * u * p2.y + u ** 3 * p3.y,
  }
}

/**
 * The whole flight, sampled every few milliseconds. `card` is where the card sits on screen
 * (`cx`, `top`, `width` in screen pixels), `crater` where it lands, `viewport` the window and
 * `zoom` the board's scale. The dragon always faces the way it flies, entering from the side
 * away from the crater so it never has to turn.
 */
export function planFlight({ card, crater, viewport, zoom = 1 }) {
  const dir = crater.x >= card.cx ? 1 : -1
  const at = {
    grab: PHASES.swoop,
    lift: PHASES.swoop + PHASES.grab,
    release: PHASES.swoop + PHASES.grab + PHASES.carry,
  }
  at.landed = at.release + PHASES.drop
  const duration = at.release + PHASES.exit
  // the claws never go so high that the dragon above them leaves the window
  const reach = CLAW.y * DRAGON_SCALE + 20
  const grabY = Math.max(40, card.top + 6)
  const liftY = Math.max(reach, Math.min(card.top - 220, viewport.h * 0.5))
  const hoverY = Math.max(reach, crater.y - 230)
  const fit = Math.min(1, CARRIED_WIDTH / Math.max(1, card.width))

  const start = { x: dir > 0 ? -260 : viewport.w + 260, y: -160 }
  const swoop = [start, { x: start.x + dir * viewport.w * 0.25, y: card.top - 300 }, { x: card.cx - dir * 240, y: card.top - 60 }, { x: card.cx, y: grabY }]
  const carry = [{ x: card.cx, y: grabY }, { x: card.cx + dir * 40, y: liftY }, { x: crater.x - dir * 180, y: Math.max(reach, Math.min(liftY, hoverY) - 40) }, { x: crater.x, y: hoverY }]
  const exit = [{ x: crater.x, y: hoverY }, { x: crater.x + dir * 120, y: hoverY - 40 }, { x: crater.x + dir * 260, y: hoverY - 200 }, { x: crater.x + dir * (viewport.w * 0.6 + 300), y: -240 }]

  const dragonAt = t => {
    if (t < at.grab) {
      const u = t / PHASES.swoop
      return { ...bezier(...swoop, ease.out(u)), s: lerp(0.35, 1, ease.out(u)), r: dir * lerp(22, 0, u) }
    }
    if (t < at.lift) {
      const u = (t - at.grab) / PHASES.grab
      return { x: card.cx, y: grabY + 10 * Math.sin(Math.PI * u), s: 1, r: 0 }
    }
    if (t < at.release) {
      const u = (t - at.lift) / PHASES.carry
      const point = bezier(...carry, ease.inOut(u))
      // a card taken high up makes the dragon sag at first, as if it were heavy, so it stays in view
      const y = Math.max(point.y, lerp(point.y, reach, Math.min(1, u * 3)))
      return { x: point.x, y, s: lerp(1, 0.62, ease.inOut(u)), r: dir * -10 * Math.sin(Math.PI * u) }
    }
    const u = Math.min(1, (t - at.release) / PHASES.exit)
    return { ...bezier(...exit, ease.in(u)), s: lerp(0.62, 0.25, u), r: dir * -18 * u }
  }

  const rest = { x: card.cx, y: card.top, k: zoom, r: 0, opacity: 1 }
  const released = dragonAt(at.release)
  const kCarried = zoom * fit
  const cargoAt = t => {
    if (t < at.grab) {
      const shake = t > at.grab - 500 ? 2.5 * Math.sin(((t - (at.grab - 500)) / 500) * Math.PI * 6) : 0
      return { ...rest, r: shake }
    }
    if (t < at.lift) {
      const u = ease.inOut((t - at.grab) / PHASES.grab)
      const claw = dragonAt(t)
      return { x: lerp(rest.x, claw.x, u), y: lerp(rest.y, claw.y, u), k: lerp(zoom, kCarried, u), r: 0, opacity: 1 }
    }
    if (t < at.release) {
      const u = (t - at.lift) / PHASES.carry
      const claw = dragonAt(t)
      return { x: claw.x, y: claw.y, k: kCarried * claw.s, r: 7 * Math.sin(u * Math.PI * 4) * (1 - u * 0.3), opacity: 1 }
    }
    const u = Math.min(1, (t - at.release) / PHASES.drop)
    return {
      x: lerp(released.x, crater.x, ease.out(u)),
      y: lerp(released.y, crater.y + 4, ease.in(u)),
      k: lerp(kCarried * released.s, kCarried * released.s * 0.1, ease.in(u)),
      r: dir * 55 * ease.in(u),
      opacity: u < 0.6 ? 1 : lerp(1, 0, (u - 0.6) / 0.4),
    }
  }

  const frames = []
  for (let t = 0; t < duration; t += STEP_MS) frames.push(t)
  frames.push(duration)
  return {
    dir,
    duration,
    landedAt: at.landed,
    breath: { from: at.grab - 650, to: at.grab - 200 },
    grabAt: at.grab,
    liftAt: at.lift,
    releaseAt: at.release,
    dragon: frames.map(t => {
      const at = dragonAt(t)
      return { offset: t / duration, ...at, s: at.s * DRAGON_SCALE }
    }),
    cargo: frames.map(t => ({ offset: t / duration, ...cargoAt(t) })),
  }
}

/** The crater the card goes into: the big middle one if it shows, else another that does. */
export function chooseCrater(craters, isCovered) {
  const byPreference = [craters[1], craters[0], craters[2]].filter(Boolean)
  return byPreference.find(crater => !isCovered(crater)) ?? byPreference[0]
}

// ---------- playing it ----------

/** Sends a copy of the card off with the dragon; the card itself is hidden at once. */
export function carryAway(cardNode) {
  const rect = cardNode?.getBoundingClientRect()
  if (!rect?.width || !cardNode.offsetWidth) return
  const width = cardNode.offsetWidth
  const zoom = rect.width / width
  const viewport = { w: window.innerWidth, h: window.innerHeight }
  const craters = infernoVolcanoes(viewport.w, viewport.h).map(v => ({ x: v.x, y: viewport.h - v.height }))
  const crater = chooseCrater(craters, point => document.elementsFromPoint(point.x, point.y + 4).some(node => node.closest?.(COVERS)))
  const plan = planFlight({ card: { cx: rect.left + rect.width / 2, top: rect.top, width: rect.width }, crater, viewport, zoom })

  const layer = document.createElement('div')
  layer.className = 'dragon-layer'
  layer.setAttribute('aria-hidden', 'true')
  const cargo = cardNode.cloneNode(true)
  cargo.classList.add('dragon-cargo')
  cargo.removeAttribute('data-session')
  cargo.style.width = `${width}px`
  const dragon = document.createElement('div')
  dragon.className = 'dragon'
  dragon.innerHTML = DRAGON_ART
  layer.append(cargo, dragon)
  document.body.append(layer)
  cardNode.classList.add('carried')

  const timing = { duration: plan.duration, fill: 'forwards' }
  cargo.animate(
    plan.cargo.map(f => ({ offset: f.offset, opacity: f.opacity, transform: `translate(${f.x}px, ${f.y}px) rotate(${f.r}deg) scale(${f.k}) translate(${-width / 2}px, 0)` })),
    timing,
  )
  dragon.animate(
    plan.dragon.map(f => ({ offset: f.offset, transform: `translate(${f.x}px, ${f.y}px) rotate(${f.r}deg) scale(${plan.dir * f.s}, ${f.s}) translate(${-CLAW.x}px, ${-CLAW.y}px)` })),
    timing,
  )
  setTimeout(() => dragon.classList.add('breathing'), plan.breath.from)
  setTimeout(() => dragon.classList.remove('breathing'), plan.breath.to)
  setTimeout(() => dragon.classList.add('holding'), plan.grabAt)
  setTimeout(() => {
    splash(layer, crater)
    eruptNear(crater.x)
  }, plan.landedAt - 60)
  setTimeout(() => layer.remove(), plan.duration + 1400)
}

/** A flash and a burst of embers where the card went in. */
function splash(layer, crater) {
  const flash = document.createElement('div')
  flash.className = 'crater-flash'
  flash.style.left = `${crater.x}px`
  flash.style.top = `${crater.y}px`
  layer.append(flash)
  flash.animate([{ transform: 'translate(-50%, -50%) scale(0.2)', opacity: 1 }, { transform: 'translate(-50%, -50%) scale(2.6)', opacity: 0 }], { duration: 900, easing: 'ease-out', fill: 'forwards' })
  for (let i = 0; i < 28; i += 1) {
    const spark = document.createElement('div')
    spark.className = 'crater-spark'
    spark.style.left = `${crater.x}px`
    spark.style.top = `${crater.y}px`
    layer.append(spark)
    const dx = (Math.random() - 0.5) * 260
    const up = 120 + Math.random() * 260
    spark.animate(
      [
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: `translate(${dx * 0.6}px, ${-up}px) scale(0.9)`, opacity: 1, offset: 0.45 },
        { transform: `translate(${dx}px, ${-up * 0.35}px) scale(0.3)`, opacity: 0 },
      ],
      { duration: 900 + Math.random() * 700, easing: 'cubic-bezier(.2,.7,.4,1)', fill: 'forwards' },
    )
  }
}

/** The dragon, facing right; its wings beat and its fire flickers in the stylesheet. */
const DRAGON_ART = `
<svg class="dragon-art" viewBox="0 0 280 200" width="280" height="200" overflow="visible">
  <defs>
    <linearGradient id="dragon-hide" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8a1e0c" /><stop offset="0.55" stop-color="#3a0805" /><stop offset="1" stop-color="#160202" />
    </linearGradient>
    <linearGradient id="dragon-belly" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffb15a" /><stop offset="1" stop-color="#c2410f" />
    </linearGradient>
    <radialGradient id="dragon-wing" cx="0.75" cy="0.9" r="0.95">
      <stop offset="0" stop-color="#ff7a2a" stop-opacity="0.95" /><stop offset="0.45" stop-color="#8a1608" stop-opacity="0.92" /><stop offset="1" stop-color="#2a0402" stop-opacity="0.96" />
    </radialGradient>
    <linearGradient id="dragon-fire" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff6c4" /><stop offset="0.35" stop-color="#ffb02a" /><stop offset="0.7" stop-color="#ff4a0a" stop-opacity="0.8" /><stop offset="1" stop-color="#ff2a00" stop-opacity="0" />
    </linearGradient>
  </defs>
  <g class="wing wing-far">
    <path d="M158 88 C170 60 186 34 210 16 C200 36 196 50 196 60 C206 50 218 46 234 46 C222 56 214 64 210 74 C198 82 178 90 160 96 Z" fill="url(#dragon-wing)" opacity="0.75" />
    <path d="M158 88 L210 16 M158 88 L234 46" class="wing-bone" />
  </g>
  <path d="M100 104 C80 108 60 120 42 126 C30 130 20 128 12 120 C24 124 34 122 44 116 C62 108 80 100 98 96 Z" fill="url(#dragon-hide)" />
  <path d="M14 121 L2 108 L6 124 L0 136 Z" fill="#5a1208" />
  <path d="M160 116 C164 128 164 140 160 150 L166 152 C170 142 170 128 168 116 Z" fill="#2a0604" />
  <path d="M96 104 C110 84 150 78 178 86 C192 90 200 98 204 104 C196 116 176 124 150 124 C126 124 106 116 96 104 Z" fill="url(#dragon-hide)" />
  <path d="M110 112 C130 121 162 122 188 112 C172 120 150 123 130 121 C120 119 114 116 110 112 Z" fill="url(#dragon-belly)" opacity="0.85" />
  <path d="M118 90 L121 79 L127 88 Z M134 85 L138 73 L143 84 Z M151 83 L156 71 L160 83 Z M168 85 L174 75 L176 87 Z" fill="#ff8a3a" opacity="0.8" />
  <path d="M176 90 C190 78 202 64 212 54 L224 62 C214 74 206 90 200 102 Z" fill="url(#dragon-hide)" />
  <path d="M208 52 C220 42 238 41 252 46 L270 54 C264 58 254 60 246 60 L260 64 C250 69 236 70 226 67 C216 64 210 60 208 52 Z" fill="url(#dragon-hide)" />
  <path d="M216 48 L204 28 L222 44 Z M228 44 L224 24 L236 41 Z" fill="#ffcf8a" opacity="0.9" />
  <circle cx="240" cy="51" r="2.6" class="dragon-eye" />
  <path d="M246 61 L262 59" stroke="#ff8a3a" stroke-width="1.4" fill="none" />
  <path d="M136 118 C138 130 138 140 134 150 L140 152 C144 142 146 130 144 118 Z" fill="#3a0805" />
  <g class="claws">
    <path d="M132 150 l-3 7 M136 152 l0 7 M141 151 l3 6 M158 150 l-3 7 M162 152 l0 7 M167 151 l3 6" stroke="#ffd27a" stroke-width="1.6" stroke-linecap="round" fill="none" />
  </g>
  <path d="M186 112 C188 122 186 130 182 136 L187 138 C192 130 194 122 192 112 Z" fill="#3a0805" />
  <g class="wing wing-near">
    <path d="M150 90 C140 62 122 32 94 10 C108 30 114 44 116 54 C102 44 84 38 62 38 C80 48 90 58 96 68 C82 64 68 66 54 72 C74 76 94 84 110 96 C126 98 140 96 150 90 Z" fill="url(#dragon-wing)" />
    <path d="M150 90 L94 10 M150 90 L62 38 M150 90 L54 72" class="wing-bone" />
  </g>
  <path d="M268 58 C292 48 322 50 346 60 C324 70 294 70 268 62 Z" fill="url(#dragon-fire)" class="dragon-fire" />
</svg>`
