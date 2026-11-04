// Keeping the cursor where it was when a part of the page is drawn again. A pick (a folder in the
// start window, a model in the session menu, a shortcut in the Keys tab) draws its list again, and
// the button the cursor was on is replaced by a new one: without this the cursor falls back onto
// the page, and the arrow keys stop working until the next click.

// what tells a button from its neighbours, before its words
const DATA_KEYS = ['folder', 'mode', 'where', 'tab', 'box', 'approval']

/**
 * What the focused element inside `container` is known by, to find it again once it is drawn anew:
 * its group's name, its data, its words and its place among its kind. Null when the focus is elsewhere.
 * `at` is the element to note when it is not the focused one: a button switched off while it works
 * has let go of the focus already.
 */
export function rememberFocus(container, at = document.activeElement) {
  if (!container || !at || at === container || !container.contains(at)) return null
  const group = at.closest('[aria-label]')
  const data = Object.fromEntries(DATA_KEYS.filter(name => at.dataset?.[name] !== undefined).map(name => [name, at.dataset[name]]))
  const kind = at.tagName
  return {
    node: at,
    kind,
    group: group && group !== at ? group.getAttribute('aria-label') : '',
    data,
    text: (at.textContent ?? '').trim(),
    index: [...container.querySelectorAll(kind)].indexOf(at),
  }
}

/** Puts the cursor back on what `rememberFocus` noted, when that element was drawn anew. */
export function restoreFocus(container, kept) {
  if (!container || !kept || kept.node.isConnected) return
  const same = [...container.querySelectorAll(kept.kind)].filter(node => !node.disabled && node.offsetParent !== null)
  const inGroup = node => !kept.group || node.closest('[aria-label]')?.getAttribute('aria-label') === kept.group
  const byData = Object.keys(kept.data).length ? same.find(node => Object.entries(kept.data).every(([name, value]) => node.dataset?.[name] === value)) : null
  const byText = same.find(node => inGroup(node) && (node.textContent ?? '').trim() === kept.text)
  const byPlace = [...container.querySelectorAll(kept.kind)][kept.index]
  ;(byData ?? byText ?? byPlace)?.focus({ preventScroll: true })
}

/** Draws a part of the page again (`draw` may be async), keeping the cursor where it was in `container`. */
export async function keepingFocus(container, draw) {
  const kept = rememberFocus(container)
  await draw()
  restoreFocus(container, kept)
}
