// The settings dialog, in tabs: the theme, the board's parts and layout, scrolling and motion, the terminal app and the editor.

import * as L from './board-logic.js'
import { THEMES } from './themes.js'

const SETTINGS_KEY = 'ccc.settings'

export function loadSettings() {
  let stored = null
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')
  } catch {
    stored = null
  }
  const prefersCalm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  return L.normalizeSettings(stored ?? (prefersCalm ? { animations: false } : null))
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // a private window: the choice lasts for this visit only
  }
}

function node(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'class') el.className = value
    else el.setAttribute(name, value)
  }
  for (const child of children) el.append(child)
  return el
}

const TAB_KEY = 'ccc.settingsTab'

/** The settings in tabs, one page at a time, so Done is always in view; the tab picked last opens again. */
function setupTabs() {
  const bar = document.querySelector('#settings-tabs')
  const show = tab => {
    const picked = L.SETTINGS_TABS.includes(tab) ? tab : 'look'
    for (const button of bar.querySelectorAll('[data-tab]')) {
      const isPicked = button.dataset.tab === picked
      button.setAttribute('aria-selected', String(isPicked))
      button.tabIndex = isPicked ? 0 : -1
    }
    for (const page of document.querySelectorAll('#settings [data-page]')) page.hidden = page.dataset.page !== picked
    try {
      localStorage.setItem(TAB_KEY, picked)
    } catch {
      // a private window: the first tab opens next time
    }
  }
  let kept = null
  try {
    kept = localStorage.getItem(TAB_KEY)
  } catch {
    kept = null
  }
  show(kept)
  bar.addEventListener('click', event => {
    const button = event.target.closest('[data-tab]')
    if (button) show(button.dataset.tab)
  })
  // the arrow keys go from tab to tab, as in any tab bar
  bar.addEventListener('keydown', event => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    const tabs = [...bar.querySelectorAll('[data-tab]')]
    const at = tabs.findIndex(button => button.getAttribute('aria-selected') === 'true')
    const next = tabs[(at + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    show(next.dataset.tab)
    next.focus()
    event.preventDefault()
  })
}

const PICK_PROMPT = 'Press a mouse button or a key… Esc cancels'

/**
 * Shift-scrolling's scroll buttons: each one, with a cross to remove it, and Add button, which waits
 * for the next press of a mouse button or a key and adds that one. Escape, a second click on Add
 * button, closing the window or turning shift-scrolling off stops the waiting; a left click elsewhere
 * goes on as a click. `show` draws the kept list; `keep` gets the new one.
 */
function setupScrollButtons(dialog, { getSettings, keep }) {
  const list = document.querySelector('#scroll-buttons')
  const button = document.querySelector('#scroll-button-add')
  let isPicking = false
  const show = (refused = '') => {
    const { shiftScroll, scrollButtons } = getSettings()
    if (!shiftScroll) stop()
    const chips = scrollButtons.map(id => {
      const name = L.scrollButtonName(id)
      const remove = node('button', { type: 'button', class: 'scroll-button-remove', 'aria-label': `Remove ${name}`, title: `Remove ${name}` }, '×')
      remove.disabled = !shiftScroll
      remove.addEventListener('click', () => keep(scrollButtons.filter(one => one !== id)))
      return node('span', { class: 'chip scroll-button', role: 'listitem' }, name, remove)
    })
    // none left: shift-scrolling is off until it is turned on again, which brings Shift back
    list.replaceChildren(...(chips.length ? chips : [node('span', { class: 'hint' }, 'None')]))
    list.classList.toggle('off', !shiftScroll)
    button.textContent = isPicking ? `${refused ? `${refused} ` : ''}${PICK_PROMPT}` : 'Add button'
    button.classList.toggle('picking', isPicking)
    button.disabled = !shiftScroll
    button.hidden = !isPicking && scrollButtons.length >= L.MAX_SCROLL_BUTTONS
  }
  const take = (event, press) => {
    const { scrollButtons } = getSettings()
    const said = L.scrollButtonPress(press, scrollButtons)
    if (!said) return
    // the press only picks: Escape does not close the window, Space does not click the button
    event.preventDefault()
    event.stopPropagation()
    if (said.refuse) return show(said.refuse)
    stop()
    if (said.pick) keep([...scrollButtons, said.pick])
  }
  const onKey = event => take(event, { kind: 'key', code: event.code, key: event.key })
  const onMouse = event => take(event, { kind: 'mouse', button: event.button })
  // the right button is refused, and opens no menu either
  const onMenu = event => event.preventDefault()
  const stop = () => {
    if (!isPicking) return
    isPicking = false
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('mousedown', onMouse, true)
    window.removeEventListener('contextmenu', onMenu, true)
    show()
  }
  button.addEventListener('click', () => {
    if (isPicking) return stop()
    isPicking = true
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onMouse, true)
    window.addEventListener('contextmenu', onMenu, true)
    show()
  })
  dialog.addEventListener('close', stop)
  return { show }
}

/** Fills and wires the dialog; `onChange` gets the new settings after every change. */
export function setupSettings(initial, { onChange, onResetLayout }) {
  let settings = initial
  const dialog = document.querySelector('#settings')
  const animations = document.querySelector('#opt-animations')
  const statusBar = document.querySelector('#opt-status-bar')
  const sidePanel = document.querySelector('#opt-side-panel')
  const wobble = document.querySelector('#opt-wobble')
  const terminalApp = document.querySelector('#opt-terminal-app')
  const shiftScroll = document.querySelector('#opt-shift-scroll')
  const editor = document.querySelector('#opt-editor')
  const showNotes = document.querySelector('#opt-show-notes')

  document.querySelector('#theme-choices').replaceChildren(
    ...THEMES.map(theme =>
      node(
        'label',
        { class: 'theme-choice' },
        Object.assign(node('input', { type: 'radio', name: 'theme', value: theme.id }), { checked: theme.id === settings.theme }),
        node('span', { class: `swatch swatch-${theme.id}`, 'aria-hidden': 'true' }),
        node('span', { class: 'name' }, theme.name),
        node('span', { class: 'about' }, theme.about),
      ),
    ),
  )
  animations.checked = settings.animations
  statusBar.checked = settings.statusBar
  sidePanel.checked = settings.sidePanel
  wobble.value = settings.wobble
  terminalApp.value = settings.terminalApp
  shiftScroll.checked = settings.shiftScroll
  editor.value = settings.editor
  showNotes.checked = settings.showNotes

  const toggle = document.querySelector('#motion-toggle')
  const freeze = document.querySelector('#freeze-toggle')
  const showMotion = () => {
    toggle.setAttribute('aria-checked', String(settings.animations))
    freeze.setAttribute('aria-checked', String(settings.freeze))
    animations.checked = settings.animations
  }
  const update = patch => {
    settings = L.normalizeSettings({ ...settings, ...patch })
    saveSettings(settings)
    showMotion()
    // removing the last scroll button turns shift-scrolling off, and the box shows it
    shiftScroll.checked = settings.shiftScroll
    scrollButtons.show()
    onChange(settings)
  }
  const scrollButtons = setupScrollButtons(dialog, { getSettings: () => settings, keep: kept => update({ scrollButtons: kept }) })
  showMotion()
  scrollButtons.show()
  // one click in the header turns every motion off or on, as the box in the settings does
  toggle.addEventListener('click', () => update({ animations: !settings.animations }))
  freeze.addEventListener('click', () => update({ freeze: !settings.freeze }))

  document.querySelector('#theme-choices').addEventListener('change', event => {
    if (event.target.name === 'theme') update({ theme: event.target.value })
  })
  animations.addEventListener('change', () => update({ animations: animations.checked }))
  statusBar.addEventListener('change', () => update({ statusBar: statusBar.checked }))
  sidePanel.addEventListener('change', () => update({ sidePanel: sidePanel.checked }))
  wobble.addEventListener('change', () => update({ wobble: wobble.value }))
  terminalApp.addEventListener('change', () => update({ terminalApp: terminalApp.value }))
  shiftScroll.addEventListener('change', () => update(L.switchShiftScroll(settings, shiftScroll.checked)))
  editor.addEventListener('change', () => update({ editor: editor.value }))
  showNotes.addEventListener('change', () => update({ showNotes: showNotes.checked }))
  setupTabs()
  document.querySelector('#layout-reset').addEventListener('click', onResetLayout)
  document.querySelector('#settings-open').addEventListener('click', () => dialog.showModal())
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close()
  })
}
