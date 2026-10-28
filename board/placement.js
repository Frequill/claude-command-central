// Where the cards sit on the board: anywhere the person puts them, held to the edges of the board
// and of the cards near them as if by magnets, and never one over another. No DOM here, so node
// can test it. A place is { x, y, w, h } in the board's own pixels, from its top left corner.

/** The room between two cards that touch, and how near an edge has to be to pull a card to it. */
export const GAP = 12
export const SNAP = 18

const right = place => place.x + place.w
const bottom = place => place.y + place.h

/** Whether two places come closer than the gap between cards. */
export function overlaps(a, b) {
  return a.x < right(b) + GAP && right(a) + GAP > b.x && a.y < bottom(b) + GAP && bottom(a) + GAP > b.y
}

/** A place kept on the board: no wider than it, not past its left, right or top edge. */
export function onBoard(place, width) {
  const w = Math.max(1, Math.min(place.w, width))
  return { ...place, w, x: Math.max(0, Math.min(place.x, width - w)), y: Math.max(0, place.y) }
}

/**
 * A card being put down near an edge sticks to it: the board's edges, and every other card's edges,
 * side by side with the gap between or lined up with them. Each axis takes its nearest edge within
 * SNAP; further off the card stays where it was let go.
 */
export function snapPlace(place, others, width) {
  const xs = [0, width - place.w]
  const ys = [0]
  for (const other of others) {
    xs.push(other.x, right(other) + GAP, other.x - GAP - place.w, right(other) - place.w)
    ys.push(other.y, bottom(other) + GAP, other.y - GAP - place.h, bottom(other) - place.h)
  }
  return {
    ...place,
    x: nearest(place.x, xs.filter(x => x >= 0 && x + place.w <= width)),
    y: nearest(place.y, ys.filter(y => y >= 0)),
  }
}

/** While a corner or an edge is pulled, the side that moves sticks to the nearest edge within SNAP. */
export function snapSides(place, sides, others, width) {
  const lefts = [0]
  const rights = [width]
  const tops = [0]
  const bottoms = []
  for (const other of others) {
    lefts.push(other.x, right(other) + GAP)
    rights.push(right(other), other.x - GAP)
    tops.push(other.y, bottom(other) + GAP)
    bottoms.push(bottom(other), other.y - GAP)
  }
  let { x, y, w, h } = place
  if (sides.left) {
    const edge = nearest(x, lefts)
    w += x - edge
    x = edge
  }
  if (sides.right) w = nearest(x + w, rights) - x
  if (sides.top) {
    const edge = nearest(y, tops)
    h += y - edge
    y = edge
  }
  if (sides.bottom) h = nearest(y + h, bottoms) - y
  return { ...place, x, y, w, h }
}

/**
 * A pulled side stops at the card next to it, leaving the gap: a card is never stretched over its
 * neighbour to the left, the right or above. Pulled down it may reach a card below, which then
 * makes way, as for a card that grows.
 */
export function limitSides(place, from, sides, others) {
  const besideRows = other => other.y < bottom(from) + GAP && bottom(other) + GAP > from.y
  const besideColumns = other => other.x < right(from) + GAP && right(other) + GAP > from.x
  let { x, y, w, h } = place
  if (sides.left) {
    const wall = Math.max(0, ...others.filter(other => besideRows(other) && right(other) <= from.x).map(other => right(other) + GAP))
    if (x < wall) {
      w -= wall - x
      x = wall
    }
  }
  if (sides.right) {
    const walls = others.filter(other => besideRows(other) && other.x >= right(from)).map(other => other.x - GAP)
    if (walls.length) w = Math.min(w, Math.min(...walls) - x)
  }
  if (sides.top) {
    const wall = Math.max(0, ...others.filter(other => besideColumns(other) && bottom(other) <= from.y).map(other => bottom(other) + GAP))
    if (y < wall) {
      h -= wall - y
      y = wall
    }
  }
  return { ...place, x, y, w, h }
}

function nearest(value, candidates) {
  let best = value
  let distance = SNAP + 1
  for (const candidate of candidates) {
    const off = Math.abs(candidate - value)
    if (off < distance) {
      best = candidate
      distance = off
    }
  }
  return best
}

/** A place moved down, past every card it would lie over, until it is free. */
export function below(place, others) {
  let free = place
  for (let round = 0; round <= others.length; round += 1) {
    const hit = others.filter(other => overlaps(free, other))
    if (hit.length === 0) return free
    free = { ...free, y: Math.max(...hit.map(bottom)) + GAP }
  }
  return free
}

/**
 * A place moved out of the way of every card it would lie over, by the shorter way: aside to the
 * right when that is less of a move and there is room on the board, else down. So a chat that gets
 * wider pushes the card beside it along, and one that gets taller pushes the card under it down.
 */
export function makeRoom(place, others, width) {
  let free = place
  for (let round = 0; round <= others.length; round += 1) {
    const hit = others.filter(other => overlaps(free, other))
    if (hit.length === 0) return free
    const aside = { ...free, x: Math.max(...hit.map(right)) + GAP }
    const down = { ...free, y: Math.max(...hit.map(bottom)) + GAP }
    const fitsAside = right(aside) <= width && !others.some(other => overlaps(aside, other))
    free = fitsAside && aside.x - free.x < down.y - free.y ? aside : down
  }
  return free
}

/**
 * The first free spot for a card of `size` among the cards placed: top first, then left, at the
 * board's top left corner, beside a card or under one.
 */
export function firstFreeSpot(size, placed, width) {
  const w = Math.min(size.w, width)
  const spots = [{ x: 0, y: 0 }]
  for (const other of placed) {
    spots.push({ x: right(other) + GAP, y: other.y }, { x: other.x, y: bottom(other) + GAP }, { x: 0, y: bottom(other) + GAP })
  }
  spots.sort((a, b) => a.y - b.y || a.x - b.x)
  for (const spot of spots) {
    const place = { ...size, w, x: spot.x, y: spot.y }
    if (place.x + w <= width && !placed.some(other => overlaps(place, other))) return place
  }
  return { ...size, w, x: 0, y: placed.reduce((low, other) => Math.max(low, bottom(other) + GAP), 0) }
}

/**
 * Every card's place on a board `width` wide, and how tall the board gets. Cards with a place keep
 * it, from the top down, except that one is moved out of the way of a card that grew into it (aside
 * or down, whichever is less); it goes back when that card shrinks again. Cards with no place yet go
 * to the first free spot, in the order given.
 */
export function arrange(cards, width) {
  const placed = []
  const places = new Map()
  const hasPlace = card => Number.isFinite(card.x) && Number.isFinite(card.y)
  const kept = cards.filter(hasPlace).sort((a, b) => a.y - b.y || a.x - b.x)
  for (const card of kept) {
    const place = makeRoom(onBoard(card, width), placed, width)
    placed.push(place)
    places.set(card.id, place)
  }
  for (const card of cards.filter(card => !hasPlace(card))) {
    const place = firstFreeSpot(card, placed, width)
    placed.push(place)
    places.set(card.id, place)
  }
  return { places, height: placed.reduce((low, place) => Math.max(low, bottom(place)), 0) }
}

/**
 * Where a card let go at `place` comes to rest: on the board, stuck to a near edge, and under any
 * card it would lie over, so the card moved gives way and the others stay put.
 */
export function dropPlace(place, others, width) {
  return below(snapPlace(onBoard(place, width), others, width), others)
}
