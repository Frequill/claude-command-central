// Background scenes. Aero lives in the page's own markup; the others draw on one canvas.

// in the order the settings show them: the calm ones first, Clean being the default
export const THEMES = [
  { id: 'clean', name: 'Clean', about: 'Light and calm, nothing moves' },
  { id: 'clean-dark', name: 'Clean Dark', about: 'Clean, in dark grey: easy on the eyes at night' },
  { id: 'macos', name: 'macOS', about: 'Soft grey Liquid Glass, traffic lights and capsule buttons' },
  { id: 'aero', name: 'Aero 2007', about: 'Sky, grass, glass and soap bubbles' },
  { id: 'xp', name: 'Windows XP', about: 'Bliss, Luna blue and the four-colour flag' },
  { id: 'win98', name: 'Windows 98', about: 'Teal desktop, grey bevels and navy title bars' },
  { id: 'spectrum', name: 'ZX Spectrum', about: 'Loading from tape: border stripes, rainbow, 8×8 pixels' },
  { id: 'inferno', name: 'Inferno', about: 'Volcanoes, dragons, embers and ash' },
  { id: 'neon', name: 'Neon City', about: 'Cyberpunk skyline, rain and a neon grid' },
  { id: 'cyberpunk', name: 'Cyberpunk 2077', about: 'Night City HUD: red lines, cut corners, glitches and a minimap' },
  { id: 'space', name: 'Deep Space', about: 'Stars, nebulae and shooting stars' },
  { id: 'eva', name: 'Evangelion', about: 'Tokyo-3 at night, a crystal angel and hex alerts' },
]

// the scenes are soft glows and specks, so a pixel per point is sharp enough
const MAX_DPR = 1
// frames a second the scene draws: smooth enough to watch, and far less than a display's 60 or 120.
// With "Freeze in background" on, the scene holds still while the person works in another window,
// and goes on when they come back.
const FPS = 30

/** Starts the theme's background and returns the function that stops it. */
export function startScene(canvas, themeId, { animated, freezeAway = false }) {
  const make = CANVAS_SCENES[themeId]
  document.body.classList.toggle('scene-on-canvas', Boolean(make))
  if (!make) return () => {}
  return runCanvas(canvas, make(), animated, freezeAway)
}

const CANVAS_SCENES = { inferno, neon, cyberpunk, space, eva, xp, spectrum }

/** Inferno's three volcanoes for a window of this size. The dragon that takes a removed card away aims at their craters. */
export function infernoVolcanoes(w, h) {
  return [
    { x: 0.16 * w, base: 0.5 * w, top: 0.05 * w, height: 0.36 * h },
    { x: 0.6 * w, base: 0.7 * w, top: 0.07 * w, height: 0.56 * h },
    { x: 0.92 * w, base: 0.45 * w, top: 0.045 * w, height: 0.3 * h },
  ]
}

/** Asks the Inferno scene to erupt the volcano nearest `x`, as a card lands in it. */
export function eruptNear(x) {
  window.dispatchEvent(new CustomEvent('ccc:erupt', { detail: { x } }))
}

// ---------- the loop every canvas scene shares ----------

function runCanvas(canvas, scene, animated, freezeAway) {
  const ctx = canvas.getContext('2d')
  let width = 0
  let height = 0
  let frame = 0
  let last = performance.now()

  const resize = () => {
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1)
    width = window.innerWidth
    height = window.innerHeight
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    scene.resize(width, height, ctx)
    if (!animated) scene.draw(ctx, 0, 0)
  }

  const tick = now => {
    if (freezeAway && !document.hasFocus()) {
      frame = 0
      return
    }
    frame = requestAnimationFrame(tick)
    // a frame a little early still draws, so a 60 Hz display does not fall to every third frame
    if (now - last < 1000 / FPS - 4) return
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    scene.draw(ctx, dt, now / 1000)
  }

  const onFocus = () => {
    if (!animated || frame) return
    last = performance.now()
    frame = requestAnimationFrame(tick)
  }

  const onErupt = event => scene.eruptNear?.(event.detail?.x)

  resize()
  scene.prime?.()
  window.addEventListener('resize', resize)
  window.addEventListener('ccc:erupt', onErupt)
  window.addEventListener('focus', onFocus)
  // the first frame draws even in a window not in use, so the scene is there to see
  if (animated) frame = requestAnimationFrame(now => {
    scene.draw(ctx, 0, now / 1000)
    last = now
    frame = requestAnimationFrame(tick)
  })
  else scene.draw(ctx, 0, 0)

  return () => {
    cancelAnimationFrame(frame)
    window.removeEventListener('resize', resize)
    window.removeEventListener('ccc:erupt', onErupt)
    window.removeEventListener('focus', onFocus)
    ctx.clearRect(0, 0, width, height)
  }
}

// ---------- small helpers ----------

const rand = (low, high) => low + Math.random() * (high - low)
const pick = list => list[Math.floor(Math.random() * list.length)]

/** A soft round glow drawn once, then stamped many times. */
function glowSprite(radius, stops) {
  const sprite = document.createElement('canvas')
  sprite.width = sprite.height = radius * 2
  const g = sprite.getContext('2d')
  const gradient = g.createRadialGradient(radius, radius, 0, radius, radius, radius)
  for (const [at, color] of stops) gradient.addColorStop(at, color)
  g.fillStyle = gradient
  g.fillRect(0, 0, radius * 2, radius * 2)
  return sprite
}

function stamp(ctx, sprite, x, y, size, alpha) {
  ctx.globalAlpha = alpha
  ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size)
}

// ==========================================================================
// Inferno: volcanoes that erupt, dragons that cross and breathe fire,
// embers that rise and ash that falls.
// ==========================================================================

function inferno() {
  const ember = glowSprite(24, [
    [0, 'rgba(255,248,210,1)'],
    [0.22, 'rgba(255,190,70,0.95)'],
    [0.55, 'rgba(255,80,10,0.35)'],
    [1, 'rgba(255,60,0,0)'],
  ])
  const glow = glowSprite(64, [
    [0, 'rgba(255,170,60,0.9)'],
    [0.4, 'rgba(255,80,10,0.35)'],
    [1, 'rgba(255,40,0,0)'],
  ])
  const smokeSprite = glowSprite(64, [
    [0, 'rgba(40,24,22,0.55)'],
    [0.6, 'rgba(30,18,16,0.25)'],
    [1, 'rgba(20,10,10,0)'],
  ])
  let w = 0
  let h = 0
  let sky
  let volcanoes = []
  let ridge = []
  const embers = []
  const ash = []
  const bombs = []
  const fire = []
  const smoke = []
  const dragons = []
  let nextDragon = 2
  let nextEruption = 3
  let flash = 0

  const newEmber = scatter => ({
    x: rand(0, w),
    y: scatter ? rand(0, h) : h + rand(0, 40),
    vx: rand(-12, 12),
    vy: rand(-75, -25),
    size: rand(4, 13),
    life: 0,
    max: rand(5, 12),
    phase: rand(0, 6.3),
  })
  const newAsh = scatter => ({
    x: rand(-50, w),
    y: scatter ? rand(0, h) : rand(-40, -5),
    vx: rand(8, 26),
    vy: rand(14, 40),
    size: rand(1, 3.2),
    spin: rand(0, 6.3),
    dark: Math.random() < 0.4,
  })

  function resize(width, height, ctx) {
    w = width
    h = height
    sky = ctx.createLinearGradient(0, 0, 0, h)
    sky.addColorStop(0, '#0b0101')
    sky.addColorStop(0.45, '#2a0604')
    sky.addColorStop(0.78, '#7a1a07')
    sky.addColorStop(1, '#c83b0d')
    volcanoes = infernoVolcanoes(w, h)
    ridge = Array.from({ length: 24 }, (_, i) => ({ x: (i / 23) * w, y: h - rand(0.05, 0.16) * h }))
  }

  function prime() {
    for (let i = 0; i < 150; i += 1) embers.push(newEmber(true))
    for (let i = 0; i < 110; i += 1) ash.push(newAsh(true))
  }

  function erupt(v = pick(volcanoes)) {
    const peak = h - v.height
    flash = 1
    for (let i = 0; i < 38; i += 1) {
      bombs.push({ x: v.x + rand(-v.top / 3, v.top / 3), y: peak, vx: rand(-160, 160), vy: rand(-460, -200), life: 0, max: rand(1.6, 2.8), size: rand(8, 22) })
    }
  }

  function eruptNear(x) {
    if (!Number.isFinite(x) || volcanoes.length === 0) return
    erupt(volcanoes.reduce((best, v) => (Math.abs(v.x - x) < Math.abs(best.x - x) ? v : best)))
    nextEruption = Math.max(nextEruption, 3)
  }

  function spawnDragon() {
    const dir = Math.random() < 0.5 ? 1 : -1
    const scale = rand(0.5, 1.15)
    dragons.push({ x: dir > 0 ? -160 : w + 160, y: rand(0.1, 0.42) * h, dir, scale, speed: rand(70, 130) * scale, phase: rand(0, 6.3), breath: rand(1.5, 4) })
  }

  function draw(ctx, dt, t) {
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, w, h)

    nextEruption -= dt
    if (nextEruption <= 0) {
      erupt()
      nextEruption = rand(4, 9)
    }
    nextDragon -= dt
    if (nextDragon <= 0 && dragons.length < 2) {
      spawnDragon()
      nextDragon = rand(6, 14)
    }
    flash = Math.max(0, flash - dt * 1.4)

    // a red glow low in the sky, brighter when something erupts
    ctx.globalCompositeOperation = 'lighter'
    stamp(ctx, glow, w * 0.6, h * 0.62, Math.max(w, h) * (1.1 + flash * 0.3), 0.18 + flash * 0.25)
    ctx.globalCompositeOperation = 'source-over'

    // far dragons fly behind the volcanoes
    for (const d of dragons) if (d.scale < 0.8) drawDragon(ctx, d, t)

    volcanoes.forEach((v, i) => drawVolcano(ctx, v, i, t))

    // smoke rising out of each crater
    if (dt > 0 && Math.random() < dt * 6) {
      const v = pick(volcanoes)
      smoke.push({ x: v.x + rand(-v.top / 3, v.top / 3), y: h - v.height, vx: rand(-8, 14), vy: rand(-30, -14), size: rand(40, 80), life: 0, max: rand(5, 9) })
    }
    for (let i = smoke.length - 1; i >= 0; i -= 1) {
      const s = smoke[i]
      s.life += dt
      s.x += s.vx * dt
      s.y += s.vy * dt
      s.size += dt * 22
      if (s.life > s.max) smoke.splice(i, 1)
      else stamp(ctx, smokeSprite, s.x, s.y, s.size, Math.sin((s.life / s.max) * Math.PI) * 0.9)
    }

    // near dragons fly in front, and breathe fire now and then
    for (const d of dragons) if (d.scale >= 0.8) drawDragon(ctx, d, t)
    moveDragons(dt, t)

    // the ground in front
    ctx.globalAlpha = 1
    ctx.fillStyle = '#060101'
    ctx.beginPath()
    ctx.moveTo(0, h)
    for (const p of ridge) ctx.lineTo(p.x, p.y)
    ctx.lineTo(w, h)
    ctx.closePath()
    ctx.fill()

    ctx.globalCompositeOperation = 'lighter'
    moveBombs(ctx, dt)
    moveFire(ctx, dt)
    for (const e of embers) {
      e.life += dt
      e.x += (e.vx + Math.sin(t * 1.3 + e.phase) * 14) * dt
      e.y += e.vy * dt
      if (e.y < -20 || e.life > e.max) Object.assign(e, newEmber(false))
      const twinkle = 0.55 + 0.45 * Math.sin(t * 7 + e.phase * 3)
      stamp(ctx, ember, e.x, e.y, e.size * 2, Math.min(1, (e.max - e.life) / 2) * twinkle)
    }
    ctx.globalCompositeOperation = 'source-over'
    for (const a of ash) {
      a.x += (a.vx + Math.sin(t + a.spin) * 6) * dt
      a.y += a.vy * dt
      a.spin += dt
      if (a.y > h + 10 || a.x > w + 60) Object.assign(a, newAsh(false))
      ctx.globalAlpha = a.dark ? 0.55 : 0.32
      ctx.fillStyle = a.dark ? '#1c1414' : '#b9aaa2'
      ctx.save()
      ctx.translate(a.x, a.y)
      ctx.rotate(a.spin)
      ctx.fillRect(-a.size, -a.size / 2, a.size * 2, a.size)
      ctx.restore()
    }
    ctx.globalAlpha = 1
  }

  function drawVolcano(ctx, v, i, t) {
    const peak = h - v.height
    ctx.globalAlpha = 1
    ctx.fillStyle = i === 1 ? '#160403' : '#1f0605'
    ctx.beginPath()
    ctx.moveTo(v.x - v.base / 2, h)
    ctx.quadraticCurveTo(v.x - v.top * 1.4, peak + v.height * 0.25, v.x - v.top / 2, peak)
    ctx.lineTo(v.x + v.top / 2, peak)
    ctx.quadraticCurveTo(v.x + v.top * 1.4, peak + v.height * 0.25, v.x + v.base / 2, h)
    ctx.closePath()
    ctx.fill()

    // lava running down the slopes
    const pulse = 0.65 + 0.35 * Math.sin(t * 1.8 + i)
    for (const side of [-1, 1]) {
      ctx.beginPath()
      ctx.moveTo(v.x + (side * v.top) / 4, peak + 2)
      ctx.bezierCurveTo(v.x + side * v.top, peak + v.height * 0.3, v.x + side * v.top * 0.4, peak + v.height * 0.6, v.x + side * v.top * 1.6, h)
      ctx.strokeStyle = `rgba(255,90,20,${0.25 * pulse})`
      ctx.lineWidth = 10
      ctx.stroke()
      ctx.strokeStyle = `rgba(255,190,70,${0.75 * pulse})`
      ctx.lineWidth = 2.5
      ctx.stroke()
    }
    ctx.globalCompositeOperation = 'lighter'
    stamp(ctx, glow, v.x, peak, v.top * 4, 0.55 * pulse + flash * 0.3)
    ctx.globalCompositeOperation = 'source-over'
  }

  function moveDragons(dt, t) {
    for (let i = dragons.length - 1; i >= 0; i -= 1) {
      const d = dragons[i]
      d.x += d.dir * d.speed * dt
      d.y += Math.sin(t * 0.8 + d.phase) * 10 * dt
      d.breath -= dt
      if (d.breath <= 0 && d.scale >= 0.7) {
        d.breathing = 1.2
        d.breath = rand(4, 9)
      }
      if (d.breathing > 0) {
        d.breathing -= dt
        const headX = d.x + d.dir * 80 * d.scale
        const headY = d.y - 8 * d.scale
        for (let k = 0; k < 4; k += 1) {
          fire.push({ x: headX, y: headY, vx: d.dir * rand(180, 320) * d.scale + d.dir * d.speed, vy: rand(-30, 40), life: 0, max: rand(0.4, 0.8), size: rand(14, 30) * d.scale })
        }
      }
      if (d.x < -220 || d.x > w + 220) dragons.splice(i, 1)
    }
  }

  function moveBombs(ctx, dt) {
    for (let i = bombs.length - 1; i >= 0; i -= 1) {
      const b = bombs[i]
      b.life += dt
      b.vy += 300 * dt
      b.x += b.vx * dt
      b.y += b.vy * dt
      if (b.life > b.max || b.y > h) bombs.splice(i, 1)
      else stamp(ctx, ember, b.x, b.y, b.size * (1 - b.life / b.max) + 4, 1 - b.life / b.max)
    }
  }

  function moveFire(ctx, dt) {
    for (let i = fire.length - 1; i >= 0; i -= 1) {
      const f = fire[i]
      f.life += dt
      f.x += f.vx * dt
      f.y += f.vy * dt
      f.size += dt * 40
      if (f.life > f.max) fire.splice(i, 1)
      else stamp(ctx, ember, f.x, f.y, f.size, 1 - f.life / f.max)
    }
  }

  return { resize, prime, draw, eruptNear }
}

/** A dragon in silhouette: body, neck and head, a waving tail and two flapping wings. */
function drawDragon(ctx, d, t) {
  const flap = Math.sin(t * 6 + d.phase)
  const wave = Math.sin(t * 3 + d.phase)
  ctx.save()
  ctx.translate(d.x, d.y)
  ctx.scale(d.dir * d.scale, d.scale)
  ctx.globalAlpha = 0.92
  ctx.fillStyle = '#100303'
  ctx.strokeStyle = 'rgba(255,100,30,0.35)'
  ctx.lineWidth = 1.2

  // far wing, a little darker
  wing(ctx, -flap * 0.8, '#0a0202')

  // body, tail and neck
  ctx.beginPath()
  ctx.moveTo(-40, -6)
  ctx.bezierCurveTo(-10, -14, 20, -12, 38, -6)
  ctx.bezierCurveTo(52, -14, 62, -20, 74, -16)
  ctx.lineTo(88, -12)
  ctx.lineTo(76, -6)
  ctx.lineTo(80, -2)
  ctx.lineTo(66, -6)
  ctx.bezierCurveTo(56, -2, 48, 2, 38, 4)
  ctx.bezierCurveTo(20, 10, -10, 10, -40, 4)
  ctx.bezierCurveTo(-70, 8 + wave * 6, -95, -6 + wave * 10, -125, 2 + wave * 12)
  ctx.lineTo(-138, -6 + wave * 12)
  ctx.lineTo(-130, 8 + wave * 12)
  ctx.lineTo(-122, 4 + wave * 12)
  ctx.bezierCurveTo(-95, 2 + wave * 10, -70, -2 + wave * 6, -40, -6)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // horns
  ctx.beginPath()
  ctx.moveTo(72, -17)
  ctx.lineTo(64, -28)
  ctx.lineTo(76, -18)
  ctx.fill()

  wing(ctx, flap, '#100303')
  ctx.restore()
}

function wing(ctx, flap, color) {
  const tip = -70 * flap
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(10, -8)
  ctx.quadraticCurveTo(-4, tip * 0.6 - 10, -18, tip - 6)
  ctx.lineTo(-30, tip * 0.7)
  ctx.lineTo(-42, tip * 0.85 + 4)
  ctx.lineTo(-52, tip * 0.55)
  ctx.lineTo(-64, tip * 0.6 + 6)
  ctx.quadraticCurveTo(-40, -4, -24, -4)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
}

// ==========================================================================
// Neon City: a synthwave sun, a skyline with flickering windows, flying cars,
// rain, and a neon grid rushing toward you.
// ==========================================================================

function neon() {
  const light = glowSprite(16, [
    [0, 'rgba(255,255,255,1)'],
    [0.3, 'rgba(255,255,255,0.6)'],
    [1, 'rgba(255,255,255,0)'],
  ])
  let w = 0
  let h = 0
  let horizon = 0
  let sky
  let sun
  let far = []
  let near = []
  const rain = []
  const cars = []
  let nextCar = 0.5
  let stars = []

  const newDrop = scatter => ({ x: rand(-100, w), y: scatter ? rand(0, h) : rand(-h * 0.2, 0), len: rand(10, 24), speed: rand(650, 980) })

  function skyline(count, minH, maxH, color, lit) {
    const list = []
    let x = -20
    while (x < w + 20 && list.length < count) {
      const bw = rand(28, 90)
      const bh = rand(minH, maxH) * h
      const windows = []
      for (let wy = 8; wy < bh - 6; wy += 9) {
        for (let wx = 5; wx < bw - 5; wx += 8) {
          if (Math.random() < lit) windows.push({ x: wx, y: wy, color: pick(['#00f0ff', '#ff3ec8', '#ffd400', '#9d7bff']), flick: Math.random() < 0.06 })
        }
      }
      list.push({ x, w: bw, h: bh, color, windows, antenna: Math.random() < 0.3 })
      x += bw + rand(2, 10)
    }
    return list
  }

  function resize(width, height, ctx) {
    w = width
    h = height
    horizon = h * 0.64
    sky = ctx.createLinearGradient(0, 0, 0, horizon)
    sky.addColorStop(0, '#05010f')
    sky.addColorStop(0.55, '#1d0640')
    sky.addColorStop(1, '#6a1b6b')
    sun = ctx.createLinearGradient(0, horizon - h * 0.2, 0, horizon)
    sun.addColorStop(0, '#ffe45c')
    sun.addColorStop(0.5, '#ff8a3d')
    sun.addColorStop(1, '#ff2fb0')
    far = skyline(80, 0.12, 0.3, '#170736', 0.18)
    near = skyline(60, 0.08, 0.22, '#0b0220', 0.25)
    stars = Array.from({ length: 90 }, () => ({ x: rand(0, w), y: rand(0, horizon * 0.7), r: rand(0.4, 1.3), phase: rand(0, 6.3) }))
  }

  function prime() {
    for (let i = 0; i < 260; i += 1) rain.push(newDrop(true))
  }

  function draw(ctx, dt, t) {
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, w, horizon)
    for (const s of stars) {
      ctx.globalAlpha = 0.4 + 0.4 * Math.sin(t * 2 + s.phase)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(s.x, s.y, s.r, s.r)
    }

    // the sun, cut by stripes like an old synthwave poster
    const r = h * 0.2
    ctx.globalAlpha = 1
    ctx.fillStyle = sun
    ctx.beginPath()
    ctx.arc(w / 2, horizon - r * 0.15, r, Math.PI, 0)
    ctx.lineTo(w / 2 + r, horizon)
    ctx.lineTo(w / 2 - r, horizon)
    ctx.fill()
    ctx.fillStyle = '#3a0a52'
    for (let i = 0; i < 7; i += 1) {
      const y = horizon - r * 0.15 - r * 0.6 + i * r * 0.12 + ((t * 8) % (r * 0.12))
      ctx.fillRect(w / 2 - r, y, r * 2, 1.5 + i * 0.9)
    }

    drawSkyline(ctx, far, t, 0.85)
    moveCars(ctx, dt)
    drawSkyline(ctx, near, t, 1)

    // horizon line and the grid floor
    ctx.globalAlpha = 1
    ctx.fillStyle = '#06011a'
    ctx.fillRect(0, horizon, w, h - horizon)
    ctx.strokeStyle = '#ff3ec8'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(0, horizon)
    ctx.lineTo(w, horizon)
    ctx.stroke()
    drawGrid(ctx, t)

    // rain over everything
    ctx.strokeStyle = 'rgba(170,210,255,0.35)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const d of rain) {
      d.y += d.speed * dt
      d.x += d.speed * 0.18 * dt
      if (d.y > h) Object.assign(d, newDrop(false))
      ctx.moveTo(d.x, d.y)
      ctx.lineTo(d.x - d.len * 0.18, d.y - d.len)
    }
    ctx.stroke()
  }

  function drawSkyline(ctx, buildings, t, alpha) {
    for (const b of buildings) {
      const top = horizon - b.h
      ctx.globalAlpha = 1
      ctx.fillStyle = b.color
      ctx.fillRect(b.x, top, b.w, b.h)
      for (const win of b.windows) {
        const on = win.flick ? Math.sin(t * 9 + win.x) > -0.2 : true
        if (!on) continue
        ctx.globalAlpha = 0.75 * alpha
        ctx.fillStyle = win.color
        ctx.fillRect(b.x + win.x, top + win.y, 3, 4)
      }
      if (b.antenna) {
        ctx.globalAlpha = 1
        ctx.fillStyle = b.color
        ctx.fillRect(b.x + b.w / 2 - 1, top - 16, 2, 16)
        if (Math.sin(t * 3 + b.x) > 0.2) {
          ctx.globalCompositeOperation = 'lighter'
          stamp(ctx, light, b.x + b.w / 2, top - 16, 10, 0.9)
          ctx.globalCompositeOperation = 'source-over'
        }
      }
    }
  }

  function drawGrid(ctx, t) {
    const vanishX = w / 2
    const depth = h - horizon
    ctx.lineWidth = 1.2
    for (let i = -24; i <= 24; i += 1) {
      ctx.strokeStyle = 'rgba(255,62,200,0.45)'
      ctx.beginPath()
      ctx.moveTo(vanishX + i * 6, horizon)
      ctx.lineTo(vanishX + i * w * 0.09, h)
      ctx.stroke()
    }
    const rows = 14
    const offset = (t * 0.5) % 1
    for (let i = 0; i < rows; i += 1) {
      const z = (i + offset) / rows
      const y = horizon + depth * z * z
      ctx.strokeStyle = `rgba(0,240,255,${0.15 + z * 0.6})`
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
    }
  }

  function moveCars(ctx, dt) {
    nextCar -= dt
    if (nextCar <= 0 && cars.length < 7) {
      const dir = Math.random() < 0.5 ? 1 : -1
      cars.push({ x: dir > 0 ? -40 : w + 40, y: rand(0.22, 0.55) * h, dir, speed: rand(120, 280), color: pick(['#ff3ec8', '#00f0ff', '#ffd400']) })
      nextCar = rand(0.6, 2.2)
    }
    ctx.globalCompositeOperation = 'lighter'
    for (let i = cars.length - 1; i >= 0; i -= 1) {
      const c = cars[i]
      c.x += c.dir * c.speed * dt
      if (c.x < -60 || c.x > w + 60) {
        cars.splice(i, 1)
        continue
      }
      ctx.globalAlpha = 0.5
      ctx.strokeStyle = c.color
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(c.x, c.y)
      ctx.lineTo(c.x - c.dir * 60, c.y)
      ctx.stroke()
      stamp(ctx, light, c.x, c.y, 12, 1)
    }
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }

  return { resize, prime, draw }
}

// ==========================================================================
// Deep Space: drifting stars in three layers, nebulae, a ringed planet
// and shooting stars.
// ==========================================================================

function space() {
  const starGlow = glowSprite(12, [
    [0, 'rgba(255,255,255,1)'],
    [0.35, 'rgba(200,215,255,0.5)'],
    [1, 'rgba(200,215,255,0)'],
  ])
  let w = 0
  let h = 0
  let nebula
  let layers = []
  const comets = []
  let nextComet = 2

  function resize(width, height) {
    w = width
    h = height
    nebula = document.createElement('canvas')
    nebula.width = Math.max(1, Math.round(w / 2))
    nebula.height = Math.max(1, Math.round(h / 2))
    const g = nebula.getContext('2d')
    g.globalCompositeOperation = 'lighter'
    for (const [x, y, r, color] of [
      [0.25, 0.35, 0.45, 'rgba(140,60,220,0.45)'],
      [0.7, 0.65, 0.5, 'rgba(30,140,200,0.35)'],
      [0.55, 0.2, 0.35, 'rgba(220,60,160,0.3)'],
      [0.1, 0.8, 0.3, 'rgba(60,90,220,0.3)'],
    ]) {
      const cx = x * nebula.width
      const cy = y * nebula.height
      const radius = r * Math.max(nebula.width, nebula.height)
      const gradient = g.createRadialGradient(cx, cy, 0, cx, cy, radius)
      gradient.addColorStop(0, color)
      gradient.addColorStop(1, 'rgba(0,0,0,0)')
      g.fillStyle = gradient
      g.fillRect(0, 0, nebula.width, nebula.height)
    }
    layers = [
      { count: 170, size: 0.7, speed: 3 },
      { count: 90, size: 1.2, speed: 9 },
      { count: 36, size: 2, speed: 20 },
    ].map(layer => ({ ...layer, stars: Array.from({ length: layer.count }, () => ({ x: rand(0, w), y: rand(0, h), phase: rand(0, 6.3) })) }))
  }

  function draw(ctx, dt, t) {
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.fillStyle = '#02030a'
    ctx.fillRect(0, 0, w, h)
    const drift = Math.sin(t * 0.03) * 30
    ctx.globalAlpha = 0.9
    ctx.drawImage(nebula, drift - 30, -20, w + 60, h + 40)

    for (const layer of layers) {
      for (const s of layer.stars) {
        s.x -= layer.speed * dt
        if (s.x < -4) {
          s.x = w + 4
          s.y = rand(0, h)
        }
        const twinkle = 0.55 + 0.45 * Math.sin(t * 2.5 + s.phase)
        if (layer.size > 1.5) {
          ctx.globalCompositeOperation = 'lighter'
          stamp(ctx, starGlow, s.x, s.y, layer.size * 6, twinkle)
          ctx.globalCompositeOperation = 'source-over'
        } else {
          ctx.globalAlpha = twinkle
          ctx.fillStyle = '#dfe7ff'
          ctx.fillRect(s.x, s.y, layer.size, layer.size)
        }
      }
    }

    drawPlanet(ctx, t)

    nextComet -= dt
    if (nextComet <= 0) {
      comets.push({ x: rand(0.2, 1) * w, y: rand(0, 0.4) * h, vx: -rand(500, 800), vy: rand(180, 320), life: 0, max: rand(0.8, 1.4) })
      nextComet = rand(2.5, 7)
    }
    for (let i = comets.length - 1; i >= 0; i -= 1) {
      const c = comets[i]
      c.life += dt
      c.x += c.vx * dt
      c.y += c.vy * dt
      if (c.life > c.max) {
        comets.splice(i, 1)
        continue
      }
      const fade = 1 - c.life / c.max
      const tail = ctx.createLinearGradient(c.x, c.y, c.x - c.vx * 0.18, c.y - c.vy * 0.18)
      tail.addColorStop(0, `rgba(255,255,255,${fade})`)
      tail.addColorStop(1, 'rgba(160,190,255,0)')
      ctx.globalAlpha = 1
      ctx.strokeStyle = tail
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(c.x, c.y)
      ctx.lineTo(c.x - c.vx * 0.18, c.y - c.vy * 0.18)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  function drawPlanet(ctx, t) {
    const r = Math.min(w, h) * 0.13
    const x = w * 0.84
    const y = h * 0.3
    const tilt = -0.35

    ring(ctx, x, y, r, tilt, Math.PI, Math.PI * 2, t)
    const body = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, r * 0.1, x, y, r)
    body.addColorStop(0, '#c9d6ff')
    body.addColorStop(0.45, '#6a5cff')
    body.addColorStop(1, '#120a3a')
    ctx.globalAlpha = 1
    ctx.fillStyle = body
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
    // slow cloud bands drifting across
    ctx.save()
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.clip()
    ctx.fillStyle = '#ffffff'
    for (let i = 0; i < 5; i += 1) {
      const bandY = y - r * 0.7 + i * r * 0.34
      const shift = Math.sin(t * 0.2 + i) * r * 0.25
      ctx.globalAlpha = 0.06 + (i % 2) * 0.05
      ctx.beginPath()
      ctx.ellipse(x + shift, bandY, r * 1.1, r * 0.07, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
    ring(ctx, x, y, r, tilt, 0, Math.PI, t)
  }

  function ring(ctx, x, y, r, tilt, from, to, t) {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(tilt)
    ctx.globalAlpha = 0.55 + 0.1 * Math.sin(t)
    ctx.strokeStyle = '#b8c8ff'
    ctx.lineWidth = r * 0.07
    ctx.beginPath()
    ctx.ellipse(0, 0, r * 1.75, r * 0.42, 0, from, to)
    ctx.stroke()
    ctx.globalAlpha = 0.3
    ctx.lineWidth = r * 0.03
    ctx.beginPath()
    ctx.ellipse(0, 0, r * 2.05, r * 0.52, 0, from, to)
    ctx.stroke()
    ctx.restore()
  }

  return { resize, draw }
}

// ==========================================================================
// Evangelion: Tokyo-3 at night above a red sea, its towers rising out of the
// ground and sinking back, a crystal angel turning in the sky, hex alerts
// running across the grid and, now and then, a cross of light on the horizon.
// ==========================================================================

function eva() {
  const light = glowSprite(32, [
    [0, 'rgba(255,255,255,1)'],
    [0.25, 'rgba(255,255,255,0.5)'],
    [1, 'rgba(255,255,255,0)'],
  ])
  const blue = glowSprite(64, [
    [0, 'rgba(150,215,255,0.9)'],
    [0.35, 'rgba(60,130,255,0.35)'],
    [1, 'rgba(20,60,200,0)'],
  ])
  const ember = glowSprite(64, [
    [0, 'rgba(255,240,220,1)'],
    [0.3, 'rgba(255,140,40,0.55)'],
    [1, 'rgba(255,60,0,0)'],
  ])
  // the hexes' size: the side of one, in points
  const HEX = 24
  const ROOT3 = Math.sqrt(3)
  let w = 0
  let h = 0
  let horizon = 0
  let sky
  let sea
  let grid
  let hexes = []
  let ridge = []
  let far = []
  let towers = []
  let stars = []
  let shimmer = []
  const alerts = []
  const blinks = []
  const ripples = []
  let cross = null
  let nextAlert = 3
  let nextBlink = 0.2
  let nextCross = 9
  let nextMove = 1.5

  function hexPath(ctx, x, y, r) {
    ctx.moveTo(x + r, y)
    for (let i = 1; i < 6; i += 1) ctx.lineTo(x + r * Math.cos((i * Math.PI) / 3), y + r * Math.sin((i * Math.PI) / 3))
    ctx.closePath()
  }

  function resize(width, height, ctx) {
    w = width
    h = height
    horizon = h * 0.7
    sky = ctx.createLinearGradient(0, 0, 0, horizon)
    sky.addColorStop(0, '#040208')
    sky.addColorStop(0.45, '#120822')
    sky.addColorStop(0.8, '#3a0c26')
    sky.addColorStop(1, '#8c1420')
    sea = ctx.createLinearGradient(0, horizon, 0, h)
    sea.addColorStop(0, '#6a0c18')
    sea.addColorStop(0.25, '#2c040c')
    sea.addColorStop(1, '#070104')

    // the hex grid over the sky, drawn once: faint at the top, stronger near the city
    hexes = []
    grid = document.createElement('canvas')
    grid.width = Math.ceil(w)
    grid.height = Math.ceil(horizon)
    const g = grid.getContext('2d')
    g.lineWidth = 1
    for (let col = 0, x = 0; x < w + HEX; col += 1, x = col * HEX * 1.5) {
      for (let y = col % 2 ? (HEX * ROOT3) / 2 : 0; y < horizon + HEX; y += HEX * ROOT3) {
        hexes.push({ x, y })
        g.strokeStyle = `rgba(255,130,40,${(0.025 + 0.09 * Math.min(1, y / horizon)).toFixed(3)})`
        g.beginPath()
        hexPath(g, x, y, HEX - 1.5)
        g.stroke()
      }
    }

    // the mountains round Tokyo-3, then the low city far off, then its towers
    ridge = []
    for (let x = -20, y = 0.1; x <= w + 40; x += 24) {
      y = Math.max(0.03, Math.min(0.2, y + rand(-0.025, 0.025)))
      ridge.push({ x, y: horizon - y * h * 0.9 })
    }
    far = []
    for (let x = -10; x < w + 10; x += rand(10, 26)) far.push({ x, w: rand(8, 24), h: rand(0.015, 0.06) * h })
    towers = []
    for (let x = -20; x < w + 20; ) {
      const bw = rand(16, 54)
      const full = rand(0.07, 0.26) * h
      const windows = []
      for (let wy = 7; wy < full - 5; wy += 8) {
        for (let wx = 4; wx < bw - 4; wx += 7) if (Math.random() < 0.13) windows.push({ x: wx, y: wy, color: pick(['#ffe9c2', '#ffb35c', '#d6ecff']) })
      }
      const down = Math.random() < 0.25
      towers.push({ x, w: bw, full, now: down ? full * rand(0.15, 0.5) : full, to: down ? full * 0.3 : full, windows, beacon: full > 0.17 * h, phase: rand(0, 6.3) })
      x += bw + rand(3, 14)
    }
    stars = Array.from({ length: 70 }, () => ({ x: rand(0, w), y: rand(0, horizon * 0.6), r: rand(0.4, 1.2), phase: rand(0, 6.3) }))
    shimmer = Array.from({ length: 70 }, () => ({ x: rand(0, w), z: Math.random(), len: rand(20, 90), phase: rand(0, 6.3) }))
  }

  function draw(ctx, dt, t) {
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, w, horizon)
    ctx.fillStyle = '#ffffff'
    for (const s of stars) {
      ctx.globalAlpha = 0.25 + 0.3 * Math.sin(t * 1.5 + s.phase)
      ctx.fillRect(s.x, s.y, s.r, s.r)
    }
    ctx.globalAlpha = 1
    ctx.drawImage(grid, 0, 0)

    drawAlerts(ctx, dt, t)
    drawCross(ctx, dt, t, false)
    drawAngel(ctx, dt, t)

    // the red glow behind the city
    ctx.globalCompositeOperation = 'lighter'
    stamp(ctx, ember, w * 0.5, horizon, w * 1.1, 0.16)
    ctx.globalCompositeOperation = 'source-over'

    ctx.globalAlpha = 1
    ctx.fillStyle = '#1b0c22'
    ctx.beginPath()
    ctx.moveTo(-20, horizon)
    for (const p of ridge) ctx.lineTo(p.x, p.y)
    ctx.lineTo(w + 40, horizon)
    ctx.fill()
    ctx.fillStyle = '#12081a'
    for (const b of far) ctx.fillRect(b.x, horizon - b.h, b.w, b.h)
    drawTowers(ctx, dt, t)
    drawSea(ctx, t)
    drawCross(ctx, 0, t, true)
  }

  // ---------- the hex alerts: a wave of orange running out from one spot, and single hexes blinking ----------

  function drawAlerts(ctx, dt, t) {
    nextAlert -= dt
    if (nextAlert <= 0 && hexes.length) {
      const at = pick(hexes.filter(hex => hex.y < horizon * 0.85))
      alerts.push({ x: at.x, y: at.y, born: t, reach: Math.max(w, h) * 0.75 })
      ripples.push({ born: t })
      nextAlert = rand(9, 15)
    }
    nextBlink -= dt
    if (nextBlink <= 0 && hexes.length) {
      blinks.push({ hex: pick(hexes), born: t, red: Math.random() < 0.2 })
      nextBlink = rand(0.12, 0.45)
    }

    for (let i = alerts.length - 1; i >= 0; i -= 1) {
      const a = alerts[i]
      const front = (t - a.born) * 420
      if (front > a.reach) {
        alerts.splice(i, 1)
        continue
      }
      const fade = 1 - front / a.reach
      ctx.fillStyle = '#ff7a1a'
      for (const hex of hexes) {
        const off = Math.abs(Math.hypot(hex.x - a.x, hex.y - a.y) - front)
        if (off > 70) continue
        ctx.globalAlpha = (1 - off / 70) * 0.32 * fade * (0.4 + 0.6 * Math.min(1, hex.y / horizon))
        ctx.beginPath()
        hexPath(ctx, hex.x, hex.y, HEX - 3)
        ctx.fill()
      }
      // where it started, the alert's own words
      const age = t - a.born
      if (age < 2.6) {
        ctx.globalAlpha = (age < 0.2 ? age / 0.2 : 1 - (age - 0.2) / 2.4) * (Math.sin(age * 18) > -0.3 ? 1 : 0.35)
        ctx.strokeStyle = '#ff7a1a'
        ctx.lineWidth = 2
        ctx.beginPath()
        hexPath(ctx, a.x, a.y, HEX * 1.6)
        ctx.stroke()
        ctx.fillStyle = '#ffd59a'
        ctx.font = '800 18px "Barlow Condensed", "Arial Narrow", sans-serif'
        ctx.textBaseline = 'middle'
        ctx.shadowColor = 'rgba(255,110,0,0.9)'
        ctx.shadowBlur = 8
        ctx.fillText('PATTERN BLUE', a.x + HEX * 2.1, a.y - 9)
        ctx.font = '700 12px "Barlow Condensed", "Arial Narrow", sans-serif'
        ctx.fillStyle = '#ff9a3c'
        ctx.fillText('ANALYSIS: MAGI', a.x + HEX * 2.1, a.y + 10)
        ctx.shadowBlur = 0
      }
    }

    for (let i = blinks.length - 1; i >= 0; i -= 1) {
      const b = blinks[i]
      const age = t - b.born
      if (age > 1.4) {
        blinks.splice(i, 1)
        continue
      }
      ctx.globalAlpha = (1 - age / 1.4) * 0.4 * (0.3 + 0.7 * Math.min(1, b.hex.y / horizon))
      ctx.fillStyle = b.red ? '#ff2433' : '#ff8a2a'
      ctx.beginPath()
      hexPath(ctx, b.hex.x, b.hex.y, HEX - 3)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  // ---------- the angel: a blue crystal octahedron, turning slowly, with its AT field ----------

  function angelAt(t) {
    return { x: w * 0.6, y: h * 0.24 + Math.sin(t * 0.45) * h * 0.012, s: Math.min(w, h) * 0.075 }
  }

  function drawAngel(ctx, dt, t) {
    const { x: ax, y: ay, s } = angelAt(t)
    const turn = t * 0.22
    const tilt = 0.3
    const lean = (x, y, z) => [x, y * Math.cos(tilt) - z * Math.sin(tilt), y * Math.sin(tilt) + z * Math.cos(tilt)]
    const top = lean(0, -s * 1.2, 0)
    const bottom = lean(0, s * 1.2, 0)
    const ring = [0, 1, 2, 3].map(k => lean(Math.cos(turn + (k * Math.PI) / 2) * s * 0.8, 0, Math.sin(turn + (k * Math.PI) / 2) * s * 0.8))

    ctx.globalCompositeOperation = 'lighter'
    stamp(ctx, blue, ax, ay, s * 5.5, 0.35 + 0.08 * Math.sin(t * 1.3))
    ctx.globalCompositeOperation = 'source-over'

    // the faces that look at us, lit from above on the left
    const sun = normalize([-0.45, -0.7, -0.55])
    const faces = []
    for (let k = 0; k < 4; k += 1) {
      for (const tip of [top, bottom]) faces.push([tip, ring[k], ring[(k + 1) % 4]])
    }
    for (const face of faces) {
      const [a, b, c] = face
      let n = normalize(crossOf(minus(b, a), minus(c, a)))
      const middle = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]
      if (dot(n, middle) < 0) n = n.map(v => -v)
      if (n[2] >= 0) continue
      const lit = Math.max(0, dot(n, sun))
      const shade = (low, high) => Math.round(low + (high - low) * lit)
      ctx.globalAlpha = 0.93
      ctx.fillStyle = `rgb(${shade(10, 150)},${shade(32, 220)},${shade(90, 255)})`
      ctx.strokeStyle = 'rgba(200,240,255,0.75)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(ax + a[0], ay + a[1])
      ctx.lineTo(ax + b[0], ay + b[1])
      ctx.lineTo(ax + c[0], ay + c[1])
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
    }

    // its AT field: orange octagons opening out each time an alert goes off
    for (let i = ripples.length - 1; i >= 0; i -= 1) {
      const age = t - ripples[i].born
      if (age > 2.2) {
        ripples.splice(i, 1)
        continue
      }
      for (const lag of [0, 0.25, 0.5]) {
        const u = (age - lag) / 1.7
        if (u <= 0 || u >= 1) continue
        const r = s * (1.4 + u * 2.4)
        ctx.globalAlpha = (1 - u) * 0.8
        ctx.strokeStyle = '#ff8a2a'
        ctx.lineWidth = 2.2 - u * 1.4
        ctx.beginPath()
        for (let k = 0; k < 8; k += 1) {
          const angle = (k * Math.PI) / 4 + Math.PI / 8
          const px = ax + r * Math.cos(angle)
          const py = ay + r * Math.sin(angle)
          if (k === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.closePath()
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
  }

  // ---------- the city: towers that rise out of the ground and sink back into it ----------

  function drawTowers(ctx, dt, t) {
    nextMove -= dt
    if (nextMove <= 0 && towers.length) {
      const tower = pick(towers)
      tower.to = tower.to < tower.full ? tower.full : tower.full * rand(0.12, 0.45)
      nextMove = rand(1.5, 4)
    }
    for (const b of towers) {
      if (b.now !== b.to) {
        const step = h * 0.035 * dt
        b.now = b.now < b.to ? Math.min(b.to, b.now + step) : Math.max(b.to, b.now - step)
      }
      const top = horizon - b.now
      ctx.globalAlpha = 1
      ctx.fillStyle = '#0a0410'
      ctx.fillRect(b.x, top, b.w, b.now)
      // a lit edge on the side the angel is
      ctx.fillStyle = 'rgba(90,140,255,0.16)'
      ctx.fillRect(b.x + b.w - 2, top, 2, b.now)
      for (const win of b.windows) {
        if (win.y > b.now - 5) continue
        ctx.globalAlpha = 0.7
        ctx.fillStyle = win.color
        ctx.fillRect(b.x + win.x, top + win.y, 2.5, 3)
      }
      // a moving tower shows the orange lights of its shaft
      if (b.now !== b.to) {
        ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 10)
        ctx.fillStyle = '#ff7a1a'
        ctx.fillRect(b.x - 2, horizon - 3, b.w + 4, 3)
      }
      if (b.beacon && Math.sin(t * 2 + b.phase) > 0.3) {
        ctx.globalCompositeOperation = 'lighter'
        stamp(ctx, light, b.x + b.w / 2, top - 2, 9, 1)
        ctx.globalAlpha = 1
        ctx.fillStyle = '#ff2433'
        ctx.fillRect(b.x + b.w / 2 - 1, top - 3, 2, 2)
        ctx.globalCompositeOperation = 'source-over'
      }
    }
    ctx.globalAlpha = 1
  }

  // ---------- the red sea, with the angel's light lying on it ----------

  function drawSea(ctx, t) {
    ctx.globalAlpha = 1
    ctx.fillStyle = sea
    ctx.fillRect(0, horizon, w, h - horizon)
    ctx.fillStyle = '#ff6a3a'
    ctx.fillRect(0, horizon, w, 1)
    const depth = h - horizon
    for (const line of shimmer) {
      const y = horizon + depth * line.z * line.z + 2
      ctx.globalAlpha = (0.08 + 0.22 * line.z) * (0.5 + 0.5 * Math.sin(t * 1.4 + line.phase))
      ctx.fillStyle = '#ff7a4a'
      ctx.fillRect(line.x + Math.sin(t * 0.6 + line.phase) * 12, y, line.len * (0.4 + line.z), 1)
    }
    const { x: ax, y: ay, s } = angelAt(t)
    const mirror = horizon + (horizon - ay) * 0.35
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 0; i < 6; i += 1) stamp(ctx, blue, ax + Math.sin(t * 2 + i) * 4, mirror + i * s * 0.35, s * (2.4 - i * 0.3), 0.14)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }

  // ---------- the cross of light: it blooms on the horizon, holds, and fades ----------

  function drawCross(ctx, dt, t, mirrored) {
    if (!mirrored) {
      nextCross -= dt
      if (nextCross <= 0 && !cross) {
        cross = { x: rand(0.12, 0.6) * w, born: t }
        nextCross = rand(35, 60)
      }
    }
    if (!cross) return
    const age = t - cross.born
    if (age > 5.5) {
      if (!mirrored) cross = null
      return
    }
    const grow = Math.min(1, age / 1.1)
    const glow = age < 1.1 ? grow : age < 2.6 ? 1 : 1 - (age - 2.6) / 2.9
    const tall = horizon * 0.78 * (1 - (1 - grow) ** 3)
    const thick = 6 + 10 * grow
    const armY = horizon - tall * 0.74
    const arm = tall * 0.24
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    if (mirrored) {
      ctx.translate(0, horizon)
      ctx.scale(1, -0.45)
      ctx.translate(0, -horizon)
      ctx.globalAlpha = glow * 0.35
    } else {
      ctx.globalAlpha = glow * 0.12
      ctx.fillStyle = '#ff7a1a'
      ctx.fillRect(0, 0, w, horizon)
      ctx.globalAlpha = glow
    }
    const across = (x0, x1) => {
      const g = ctx.createLinearGradient(x0, 0, x1, 0)
      g.addColorStop(0, 'rgba(255,90,20,0)')
      g.addColorStop(0.3, 'rgba(255,150,70,0.6)')
      g.addColorStop(0.5, 'rgba(255,250,240,1)')
      g.addColorStop(0.7, 'rgba(255,150,70,0.6)')
      g.addColorStop(1, 'rgba(255,90,20,0)')
      return g
    }
    ctx.fillStyle = across(cross.x - thick * 2, cross.x + thick * 2)
    ctx.fillRect(cross.x - thick * 2, horizon - tall, thick * 4, tall)
    const down = ctx.createLinearGradient(0, armY - thick * 1.5, 0, armY + thick * 1.5)
    down.addColorStop(0, 'rgba(255,90,20,0)')
    down.addColorStop(0.5, 'rgba(255,245,230,0.95)')
    down.addColorStop(1, 'rgba(255,90,20,0)')
    ctx.fillStyle = down
    ctx.fillRect(cross.x - arm, armY - thick * 1.5, arm * 2, thick * 3)
    stamp(ctx, ember, cross.x, horizon, thick * 16, 0.9)
    stamp(ctx, ember, cross.x, armY, thick * 8, 0.7)
    ctx.restore()
  }

  return { resize, draw }
}

const minus = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const crossOf = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const normalize = v => {
  const length = Math.hypot(...v) || 1
  return v.map(x => x / length)
}

// ==========================================================================
// Windows XP: Bliss. A deep blue sky with soft clouds drifting over it, and
// the rolling green hill, lit from the left, its grass stirring in the wind.
// ==========================================================================

function xp() {
  const puff = glowSprite(48, [
    [0, 'rgba(255,255,255,0.95)'],
    [0.5, 'rgba(255,255,255,0.55)'],
    [1, 'rgba(255,255,255,0)'],
  ])
  let w = 0
  let h = 0
  let sky
  let hill
  let clouds = []

  // the hill's top edge: low on the left, a broad rise just left of the middle, falling away to the right
  const ridge = x => {
    const u = x / w
    return h * (0.62 - 0.17 * Math.exp(-(((u - 0.38) / 0.33) ** 2)) + 0.05 * u * u)
  }
  // the second, lower slope behind it on the right
  const backRidge = x => {
    const u = x / w
    return h * (0.7 - 0.12 * Math.exp(-(((u - 0.86) / 0.22) ** 2)))
  }

  function newCloud(scatter) {
    const size = rand(0.12, 0.3) * w
    return {
      x: scatter ? rand(-0.2, 1.1) * w : -size,
      y: rand(0.04, 0.38) * h,
      size,
      speed: rand(5, 12),
      puffs: Array.from({ length: 9 }, () => ({ dx: rand(-0.5, 0.5), dy: rand(-0.12, 0.12), r: rand(0.35, 0.7) })),
    }
  }

  function resize(width, height, ctx) {
    w = width
    h = height
    sky = ctx.createLinearGradient(0, 0, 0, h * 0.7)
    sky.addColorStop(0, '#1a5fd0')
    sky.addColorStop(0.45, '#3f86e4')
    sky.addColorStop(0.8, '#8dbcf0')
    sky.addColorStop(1, '#c9e0f7')
    clouds = Array.from({ length: 8 }, () => newCloud(true))

    // the hill, drawn once: its green lit from the upper left, with streaks of grass across it
    hill = document.createElement('canvas')
    hill.width = Math.ceil(w)
    hill.height = Math.ceil(h)
    const g = hill.getContext('2d')
    const back = g.createLinearGradient(0, h * 0.55, 0, h)
    back.addColorStop(0, '#6cb13f')
    back.addColorStop(1, '#2f7a1c')
    g.fillStyle = back
    g.beginPath()
    g.moveTo(0, h)
    for (let x = 0; x <= w + 8; x += 8) g.lineTo(x, backRidge(x))
    g.lineTo(w, h)
    g.closePath()
    g.fill()
    const front = g.createLinearGradient(w * 0.15, h * 0.42, w * 0.6, h)
    front.addColorStop(0, '#9fd654')
    front.addColorStop(0.35, '#5fae2e')
    front.addColorStop(1, '#2b7016')
    g.fillStyle = front
    g.beginPath()
    g.moveTo(0, h)
    for (let x = 0; x <= w + 8; x += 8) g.lineTo(x, ridge(x))
    g.lineTo(w, h)
    g.closePath()
    g.fill()
    g.save()
    g.clip()
    for (let i = 0; i < 1600; i += 1) {
      const x = rand(0, w)
      const y = rand(ridge(x), h)
      const depth = (y - ridge(x)) / (h - ridge(x) + 1)
      g.globalAlpha = 0.08 + 0.12 * Math.random()
      g.strokeStyle = Math.random() < 0.5 ? '#c6ec7a' : '#245f12'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(x, y)
      g.lineTo(x + rand(6, 20) * (1 - depth * 0.5), y - rand(0, 2))
      g.stroke()
    }
    // the soft light along the hill's crest
    const crest = g.createLinearGradient(0, h * 0.42, 0, h * 0.62)
    crest.addColorStop(0, 'rgba(230,255,170,0.35)')
    crest.addColorStop(1, 'rgba(230,255,170,0)')
    g.globalAlpha = 1
    g.fillStyle = crest
    g.fillRect(0, 0, w, h)
    g.restore()
  }

  function draw(ctx, dt) {
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < clouds.length; i += 1) {
      const c = clouds[i]
      c.x += c.speed * dt
      if (c.x - c.size > w) clouds[i] = newCloud(false)
      for (const p of c.puffs) {
        const size = c.size * p.r
        ctx.globalAlpha = 0.85
        ctx.drawImage(puff, c.x + p.dx * c.size - size / 2, c.y + p.dy * c.size - size * 0.3, size, size * 0.6)
      }
    }
    ctx.globalAlpha = 1
    ctx.drawImage(hill, 0, 0)
  }

  return { resize, draw }
}

// ==========================================================================
// ZX Spectrum: a program loading from tape. The border flashes red and cyan
// for the pilot tone, then thin yellow and blue stripes while the data comes
// in; the loading screen fills in line by line in the Spectrum's own order
// (in thirds, a pixel line of each character row at a time), black ink first,
// then its colours block by block. Then it starts over.
// ==========================================================================

// the Spectrum's colours: the eight at their bright level
const ZX = { black: '#000000', blue: '#0000ff', red: '#ff0000', magenta: '#ff00ff', green: '#00ff00', cyan: '#00ffff', yellow: '#ffff00', white: '#ffffff', paper: '#d7d7d7' }
// the screen the Spectrum draws: 256 by 192 pixels, colour in blocks of 8 by 8
const ZX_W = 256
const ZX_H = 192
// how long each part of the load takes, in seconds
const LOAD = { pilot: 2.2, pixels: 7, colours: 2.4, hold: 5 }

function spectrum() {
  let w = 0
  let h = 0
  let screen = { x: 0, y: 0, scale: 1 }
  let ink
  let colour
  let shown
  let started = null
  let stripes = []

  // the loading picture: the rainbow, the name, a few blocks of colour, drawn once in ink and once in colour
  function picture(inColour) {
    const canvas = document.createElement('canvas')
    canvas.width = ZX_W
    canvas.height = ZX_H
    const g = canvas.getContext('2d')
    g.imageSmoothingEnabled = false
    g.fillStyle = inColour ? ZX.black : ZX.paper
    g.fillRect(0, 0, ZX_W, ZX_H)
    // the rainbow across the bottom right, as on the case
    const bands = [ZX.red, ZX.yellow, ZX.green, ZX.cyan]
    bands.forEach((band, i) => {
      g.fillStyle = inColour ? band : ZX.black
      g.beginPath()
      g.moveTo(120 + i * 16, ZX_H)
      g.lineTo(184 + i * 16, 104)
      g.lineTo(200 + i * 16, 104)
      g.lineTo(136 + i * 16, ZX_H)
      g.closePath()
      g.fill()
    })
    // a sky of blocks over a starry night, the colour of each 8 by 8 block its own
    for (let y = 0; y < 13; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        if ((x * 7 + y * 13) % 11 === 0) {
          g.fillStyle = inColour ? [ZX.blue, ZX.magenta, ZX.cyan, ZX.green][(x + y) % 4] : ZX.black
          g.fillRect(x * 8 + 3, y * 8 + 3, 2, 2)
        }
      }
    }
    g.fillStyle = inColour ? ZX.white : ZX.black
    g.font = '16px "Press Start 2P", monospace'
    g.textBaseline = 'top'
    g.fillText('CCC', 16, 24)
    g.font = '8px "Press Start 2P", monospace'
    g.fillStyle = inColour ? ZX.yellow : ZX.black
    g.fillText('COMMAND CENTRAL', 16, 48)
    g.fillStyle = inColour ? ZX.cyan : ZX.black
    g.fillText('ZX SPECTRUM 48K', 16, 64)
    g.fillStyle = inColour ? ZX.white : ZX.black
    g.fillText('© 1982 SINCLAIR', 16, 168)
    return canvas
  }

  function resize(width, height) {
    w = width
    h = height
    // the screen keeps the Spectrum's shape, with a wide border all round it, as on a television
    const scale = Math.max(1, Math.floor(Math.min((w * 0.84) / ZX_W, (h * 0.8) / ZX_H)))
    screen = { scale, x: Math.round((w - ZX_W * scale) / 2), y: Math.round((h - ZX_H * scale) / 2) }
    ink = picture(false)
    colour = picture(true)
    // the pixel font may come in after the first drawing: the picture is drawn again with it
    document.fonts?.load('16px "Press Start 2P"').then(() => {
      ink = picture(false)
      colour = picture(true)
    }, () => undefined)
    shown = document.createElement('canvas')
    shown.width = ZX_W
    shown.height = ZX_H
    started = null
  }

  // the pixel lines in the order the Spectrum's memory holds them: each third of the screen,
  // the first line of each of its eight character rows, then the second, and so on
  const lineAt = index => {
    const third = Math.floor(index / 64)
    const line = Math.floor((index % 64) / 8)
    const row = index % 8
    return third * 64 + row * 8 + line
  }

  function drawBorder(ctx, phase, t) {
    if (phase === 'pilot') {
      // the pilot tone: wide red and cyan stripes rolling up the border
      const band = Math.max(6, h / 34)
      const offset = (t * band * 9) % (band * 2)
      for (let y = -band * 2 + offset; y < h; y += band * 2) {
        ctx.fillStyle = ZX.red
        ctx.fillRect(0, y, w, band)
        ctx.fillStyle = ZX.cyan
        ctx.fillRect(0, y + band, w, band)
      }
      return
    }
    if (phase === 'data') {
      // the data: thin stripes of yellow and blue, a new pattern every frame
      if (stripes.length === 0 || Math.random() < 0.9) {
        stripes = []
        for (let y = 0; y < h; ) {
          const tall = rand(2, 7)
          stripes.push([y, tall])
          y += tall
        }
      }
      ctx.fillStyle = ZX.blue
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = ZX.yellow
      for (const [y, tall] of stripes) if (Math.random() < 0.5) ctx.fillRect(0, y, w, tall)
      return
    }
    ctx.fillStyle = ZX.paper
    ctx.fillRect(0, 0, w, h)
  }

  function draw(ctx, dt, t) {
    if (started === null) started = t
    const total = LOAD.pilot + LOAD.pixels + LOAD.colours + LOAD.hold
    let at = (t - started) % total
    const isStill = dt === 0
    // a still board shows the picture loaded, its border white
    if (isStill) at = total - 0.1
    const phase = at < LOAD.pilot ? 'pilot' : at < LOAD.pilot + LOAD.pixels + LOAD.colours ? 'data' : 'done'
    drawBorder(ctx, phase, t)

    const g = shown.getContext('2d')
    g.imageSmoothingEnabled = false
    g.fillStyle = ZX.paper
    g.fillRect(0, 0, ZX_W, ZX_H)
    const intoPixels = Math.max(0, at - LOAD.pilot)
    const lines = Math.min(ZX_H, Math.floor((intoPixels / LOAD.pixels) * ZX_H))
    for (let i = 0; i < lines; i += 1) {
      const y = lineAt(i)
      g.drawImage(ink, 0, y, ZX_W, 1, 0, y, ZX_W, 1)
    }
    // the colours come in after the pixels, one 8 by 8 block at a time, row by row
    const intoColours = Math.max(0, at - LOAD.pilot - LOAD.pixels)
    const blocks = Math.min(32 * 24, Math.floor((intoColours / LOAD.colours) * 32 * 24))
    for (let b = 0; b < blocks; b += 1) {
      const x = (b % 32) * 8
      const y = Math.floor(b / 32) * 8
      g.drawImage(colour, x, y, 8, 8, x, y, 8, 8)
    }
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(shown, screen.x, screen.y, ZX_W * screen.scale, ZX_H * screen.scale)
  }

  return { resize, draw }
}

// ==========================================================================
// Cyberpunk 2077: Night City at night under red smog. Megabuildings in three layers, their windows
// lit in the HUD's yellow, cyan and red, holo ads that flicker, red beacons on the tallest towers,
// flying cars crossing between them, a scanner's reticle turning slowly in the sky, and now and then
// a glitch that tears a few slices of the screen sideways.
// ==========================================================================

function cyberpunk() {
  const RED = '247,80,73'
  const CYAN = '94,246,255'
  const YELLOW = '252,238,10'
  const LIGHTS = [YELLOW, YELLOW, CYAN, CYAN, RED, '255,214,160']
  let w = 0
  let h = 0
  // the sky and the buildings do not move: drawn once per size, then copied in every frame
  let city = null
  let ads = []
  let beacons = []
  let cars = []
  let tears = []
  let tearUntil = 0
  let nextTear = 0

  function tower(ctx, x, top, width, colour, lit, depth) {
    ctx.fillStyle = colour
    ctx.fillRect(x, top, width, h - top)
    // a stepped crown on some, an antenna on the tall ones
    if (width > 40 && Math.random() < 0.6) ctx.fillRect(x + width * 0.2, top - 10, width * 0.6, 10)
    if (h - top > h * 0.55) {
      ctx.fillRect(x + width / 2 - 1, top - 46, 2, 46)
      beacons.push({ x: x + width / 2, y: top - 46, phase: rand(0, 6) })
    }
    // the windows: a tight grid, a few lit
    const gap = depth === 0 ? 5 : 7
    for (let wy = top + 8; wy < h - 6; wy += gap) {
      for (let wx = x + 4; wx < x + width - 4; wx += gap - 2) {
        if (Math.random() > lit) continue
        ctx.fillStyle = `rgba(${pick(LIGHTS)},${rand(0.25, 0.85) * (0.45 + depth * 0.25)})`
        ctx.fillRect(wx, wy, depth === 0 ? 1.5 : 2, depth === 0 ? 2 : 3)
      }
    }
  }

  function buildCity() {
    // a window with no room yet: nothing to draw until it has some
    if (!w || !h) {
      city = null
      return
    }
    city = document.createElement('canvas')
    city.width = w
    city.height = h
    const ctx = city.getContext('2d')
    beacons = []
    ads = []
    const sky = ctx.createLinearGradient(0, 0, 0, h)
    sky.addColorStop(0, '#04050a')
    sky.addColorStop(0.45, '#0a0b15')
    sky.addColorStop(0.78, '#1d0912')
    sky.addColorStop(1, '#2a0a10')
    ctx.fillStyle = sky
    ctx.fillRect(0, 0, w, h)
    // the smog the city lights from below
    const smog = ctx.createRadialGradient(w * 0.62, h * 0.95, 0, w * 0.62, h * 0.95, w * 0.7)
    smog.addColorStop(0, `rgba(${RED},0.32)`)
    smog.addColorStop(0.5, `rgba(${RED},0.08)`)
    smog.addColorStop(1, `rgba(${RED},0)`)
    ctx.fillStyle = smog
    ctx.fillRect(0, 0, w, h)
    // three layers, the far one paler and taller, each nearer one darker
    const layers = [
      { colour: '#1a1020', least: 0.3, most: 0.62, narrow: 26, wide: 70, lit: 0.05 },
      { colour: '#0e0a15', least: 0.18, most: 0.5, narrow: 40, wide: 110, lit: 0.08 },
      { colour: '#060509', least: 0.08, most: 0.3, narrow: 60, wide: 160, lit: 0.12 },
    ]
    layers.forEach((layer, depth) => {
      let x = -20
      while (x < w + 20) {
        const width = rand(layer.narrow, layer.wide)
        const top = h * (1 - rand(layer.least, layer.most))
        tower(ctx, x, top, width, layer.colour, layer.lit, depth)
        if (depth > 0 && width > 70 && Math.random() < 0.22) {
          ads.push({ x: x + width * 0.15, y: top + rand(20, 60), w: width * 0.7, h: rand(22, 46), colour: pick([CYAN, YELLOW, RED, '255,43,214']), phase: rand(0, 10) })
        }
        x += width + rand(-6, 8)
      }
      // haze between the layers, so the far ones sit back in the smog
      const haze = ctx.createLinearGradient(0, h * 0.35, 0, h)
      haze.addColorStop(0, `rgba(${RED},0)`)
      haze.addColorStop(1, `rgba(${RED},0.07)`)
      ctx.fillStyle = haze
      ctx.fillRect(0, 0, w, h)
    })
    // the megabuildings: three towers through the clouds
    for (const u of [0.12, 0.47, 0.83]) {
      const width = rand(70, 110)
      tower(ctx, u * w - width / 2, h * rand(0.12, 0.22), width, '#0b0811', 0.07, 1)
    }
  }

  function newCar(scatter) {
    const toRight = Math.random() < 0.5
    return {
      x: scatter ? rand(0, w) : toRight ? -30 : w + 30,
      y: h * rand(0.14, 0.6),
      speed: rand(40, 130) * (toRight ? 1 : -1),
      colour: toRight ? '255,70,70' : '232,244,255',
      size: rand(1.2, 2.4),
    }
  }

  function resize(width, height) {
    w = width
    h = height
    buildCity()
    cars = Array.from({ length: Math.round(w / 140) }, () => newCar(true))
  }

  function drawAd(ctx, ad, t) {
    // a holo ad: a glowing frame and lines of fake text, flickering, now and then off for a blink
    const flicker = Math.sin(t * 7 + ad.phase) > 0.97 ? 0.15 : 0.75 + 0.25 * Math.sin(t * 2.3 + ad.phase)
    ctx.globalAlpha = flicker
    ctx.fillStyle = `rgba(${ad.colour},0.14)`
    ctx.fillRect(ad.x, ad.y, ad.w, ad.h)
    ctx.strokeStyle = `rgba(${ad.colour},0.85)`
    ctx.lineWidth = 1
    ctx.strokeRect(ad.x + 0.5, ad.y + 0.5, ad.w - 1, ad.h - 1)
    ctx.fillStyle = `rgba(${ad.colour},0.7)`
    for (let line = 0; line < 3; line += 1) ctx.fillRect(ad.x + 5, ad.y + 6 + line * 7, (ad.w - 10) * (line === 0 ? 0.8 : 0.5 - line * 0.1), 2.5)
    ctx.globalAlpha = 1
  }

  function drawReticle(ctx, t) {
    const x = w * 0.2
    const y = h * 0.3
    const r = Math.min(w, h) * 0.13
    ctx.save()
    ctx.translate(x, y)
    ctx.strokeStyle = `rgba(${RED},0.16)`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.rotate(t * 0.15)
    ctx.strokeStyle = `rgba(${CYAN},0.22)`
    ctx.lineWidth = 2
    for (let i = 0; i < 4; i += 1) {
      ctx.beginPath()
      ctx.arc(0, 0, r * 0.82, i * (Math.PI / 2), i * (Math.PI / 2) + 0.7)
      ctx.stroke()
    }
    ctx.rotate(-t * 0.4)
    ctx.strokeStyle = `rgba(${RED},0.2)`
    ctx.lineWidth = 1
    for (let i = 0; i < 48; i += 1) {
      const a = (i / 48) * Math.PI * 2
      const inner = i % 4 === 0 ? r * 1.04 : r * 1.08
      ctx.beginPath()
      ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner)
      ctx.lineTo(Math.cos(a) * r * 1.12, Math.sin(a) * r * 1.12)
      ctx.stroke()
    }
    ctx.restore()
  }

  function draw(ctx, dt, t) {
    if (!city) return
    ctx.drawImage(city, 0, 0, w, h)
    for (const beacon of beacons) {
      const on = (Math.sin(t * 2.4 + beacon.phase) + 1) / 2
      ctx.fillStyle = `rgba(${RED},${0.25 + 0.75 * on})`
      ctx.beginPath()
      ctx.arc(beacon.x, beacon.y, 2.2, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = `rgba(${RED},${0.12 * on})`
      ctx.beginPath()
      ctx.arc(beacon.x, beacon.y, 9, 0, Math.PI * 2)
      ctx.fill()
    }
    for (const ad of ads) drawAd(ctx, ad, t)
    drawReticle(ctx, t)
    for (const car of cars) {
      car.x += car.speed * dt
      if (car.x < -40 || car.x > w + 40) Object.assign(car, newCar(false))
      const tail = ctx.createLinearGradient(car.x, 0, car.x - car.speed * 0.25, 0)
      tail.addColorStop(0, `rgba(${car.colour},0.8)`)
      tail.addColorStop(1, `rgba(${car.colour},0)`)
      ctx.strokeStyle = tail
      ctx.lineWidth = car.size
      ctx.beginPath()
      ctx.moveTo(car.x, car.y)
      ctx.lineTo(car.x - car.speed * 0.25, car.y)
      ctx.stroke()
      ctx.fillStyle = `rgba(${car.colour},1)`
      ctx.fillRect(car.x - car.size / 2, car.y - car.size / 2, car.size * 1.6, car.size)
    }
    // a glitch: a few slices of the screen torn sideways, tinted cyan and red, for a moment
    if (dt > 0 && t > nextTear) {
      nextTear = t + rand(5, 11)
      tearUntil = t + rand(0.12, 0.24)
      tears = Array.from({ length: Math.floor(rand(2, 5)) }, () => ({ y: rand(0, h), height: rand(4, 26), dx: rand(-28, 28), tint: Math.random() < 0.5 ? CYAN : RED }))
    }
    if (t < tearUntil) {
      for (const tear of tears) {
        ctx.drawImage(ctx.canvas, 0, tear.y, ctx.canvas.width, tear.height, tear.dx, tear.y, w, tear.height)
        ctx.fillStyle = `rgba(${tear.tint},0.1)`
        ctx.fillRect(0, tear.y, w, tear.height)
      }
    }
  }

  return { resize, draw }
}
