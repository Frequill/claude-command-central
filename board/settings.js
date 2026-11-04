// The settings dialog, in tabs: the theme, the board's parts and layout, scrolling and motion, the terminal app and the editor, the keyboard shortcuts.

import * as L from './board-logic.js'
import * as K from './keys.js'
import { rememberFocus, restoreFocus } from './refocus.js'
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
 * Hold-to-scroll's scroll buttons: each one, with a cross to remove it while another is left, and Add
 * button, which waits for the next press of a mouse button or a key and adds that one. Escape, a second
 * click on Add button, closing the window or turning hold-to-scroll off stops the waiting; a left click elsewhere
 * goes on as a click. `show` draws the kept list; `keep` gets the new one.
 */
function setupScrollButtons(dialog, { getSettings, keep }) {
  const list = document.querySelector('#scroll-buttons')
  const button = document.querySelector('#scroll-button-add')
  let isPicking = false
  const show = (refused = '') => {
    const { shiftScroll, scrollButtons } = getSettings()
    if (!shiftScroll) stop()
    // the last one stays: without a scroll button nothing could move the board
    const isLast = scrollButtons.length === 1
    const chips = scrollButtons.map(id => {
      const name = L.scrollButtonName(id)
      const about = isLast ? 'Add another button before removing this one' : `Remove ${name}`
      const remove = node('button', { type: 'button', class: 'scroll-button-remove', 'aria-label': about, title: about }, '×')
      remove.disabled = !shiftScroll || isLast
      remove.addEventListener('click', () => keep(scrollButtons.filter(one => one !== id)))
      return node('span', { class: 'chip scroll-button', role: 'listitem' }, name, remove)
    })
    list.replaceChildren(...chips)
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
const KEY_PROMPT = 'Press the new keys… Esc cancels'

/**
 * The Keys tab: every command with its shortcut, as this keyboard writes it, a Change button that
 * waits for the next keys pressed, a Remove button, and Reset to defaults. A shortcut given to a
 * command another one had moves to it, and the tab says so. `keep` gets the person's own keys.
 */
function setupKeys(dialog, { getSettings, keep }) {
  const list = document.querySelector('#keys-list')
  const status = document.querySelector('#keys-status')
  const reset = document.querySelector('#keys-reset')
  let picking = null
  let layout = null
  const say = text => {
    status.textContent = text
    status.hidden = !text
  }
  const label = id => K.COMMANDS.find(command => command.id === id)?.label ?? id
  const show = () => {
    const own = getSettings().keys
    // off, the list stays to look at and change, greyed, as the board takes none of its keys
    list.classList.toggle('off', !getSettings().shortcuts)
    const bound = K.bindings(own)
    const groups = [...new Set(K.COMMANDS.map(command => command.group))]
    // drawn again after a change: the cursor stays on that row's button
    const kept = rememberFocus(list)
    list.replaceChildren(
      ...groups.map(group =>
        node(
          'fieldset',
          { class: 'keys-group' },
          node('legend', {}, group),
          ...K.COMMANDS.filter(command => command.group === group).map(command => {
            const keys = bound[command.id]
            const isPicking = picking === command.id
            const shown = isPicking ? KEY_PROMPT : keys.length ? keys.map(chord => K.formatChord(chord, layout)).join('  ') : 'No key'
            const chip = node('span', { class: `chip key-chip${keys.length ? '' : ' none'}${isPicking ? ' picking' : ''}` }, shown)
            const change = node('button', { type: 'button', class: 'secondary key-change' }, isPicking ? 'Cancel' : 'Change')
            change.addEventListener('click', () => (isPicking ? stop() : start(command.id)))
            const remove = node('button', { type: 'button', class: 'scroll-button-remove key-remove', 'aria-label': `Remove the shortcut of ${command.label}`, title: 'No shortcut for this' }, '×')
            remove.disabled = keys.length === 0
            remove.addEventListener('click', () => keep(K.cleanCustom({ ...own, [command.id]: [] })))
            const isChanged = command.id in own
            const defaults = command.keys.map(chord => K.formatChord(chord, layout)).join(' ') || 'no shortcut'
            const back = node('button', { type: 'button', class: 'scroll-button-remove key-back', 'aria-label': `Put back the default shortcut of ${command.label}`, title: `Put back ${defaults}` }, '↺')
            // kept in its place when there is nothing to put back, so the rows line up
            back.classList.toggle('unchanged', !isChanged)
            back.disabled = !isChanged
            back.addEventListener('click', () => {
              const rest = { ...own }
              delete rest[command.id]
              keep(K.cleanCustom(rest))
            })
            return node(
              'div',
              { class: `key-row${isChanged ? ' changed' : ''}`, role: 'group', 'aria-label': command.label },
              node('span', { class: 'key-label' }, command.label, isChanged ? node('span', { class: 'key-changed' }, ' · changed') : ''),
              chip,
              change,
              back,
              remove,
            )
          }),
        ),
      ),
    )
    reset.disabled = Object.keys(own).length === 0
    restoreFocus(list, kept)
  }
  const onKey = event => {
    if (!picking) return
    // the keys pressed only pick: Escape does not close the window, Enter does not click anything
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      return stop()
    }
    const chord = K.chordOf(event)
    if (!chord) return
    event.preventDefault()
    event.stopPropagation()
    const problem = K.bindProblem(chord)
    if (problem) return say(problem)
    const id = picking
    const { custom, movedFrom } = K.rebind(getSettings().keys, id, chord)
    picking = null
    window.removeEventListener('keydown', onKey, true)
    say(movedFrom.length ? `${K.formatChord(chord, layout)} is now ${label(id)}. ${movedFrom.map(label).join(' and ')} has no shortcut now.` : `${K.formatChord(chord, layout)} is now ${label(id)}.`)
    keep(custom)
  }
  const start = id => {
    picking = id
    say('')
    window.addEventListener('keydown', onKey, true)
    show()
  }
  const stop = () => {
    if (!picking) return
    picking = null
    window.removeEventListener('keydown', onKey, true)
    show()
  }
  reset.addEventListener('click', () => {
    stop()
    say('Every shortcut is back to its default.')
    keep({})
  })
  // a note about a change is for then: closed, Settings opens next time without it
  dialog.addEventListener('close', () => {
    stop()
    say('')
  })
  // the keyboard's own letters, so a symbol key shows as it is on this keyboard
  navigator.keyboard
    ?.getLayoutMap?.()
    .then(map => {
      layout = map
      show()
    })
    .catch(() => {})
  say('')
  return { show }
}

export function setupSettings(initial, { onChange, onResetLayout, onCloseGaps }) {
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
  const shortcuts = document.querySelector('#opt-shortcuts')

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
  shortcuts.checked = settings.shortcuts

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
    scrollButtons.show()
    keys.show()
    onChange(settings)
  }
  const scrollButtons = setupScrollButtons(dialog, { getSettings: () => settings, keep: kept => update({ scrollButtons: kept }) })
  const keys = setupKeys(dialog, { getSettings: () => settings, keep: kept => update({ keys: kept }) })
  showMotion()
  scrollButtons.show()
  keys.show()
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
  shiftScroll.addEventListener('change', () => update({ shiftScroll: shiftScroll.checked }))
  editor.addEventListener('change', () => update({ editor: editor.value }))
  showNotes.addEventListener('change', () => update({ showNotes: showNotes.checked }))
  shortcuts.addEventListener('change', () => update({ shortcuts: shortcuts.checked }))
  setupTabs()
  document.querySelector('#layout-reset').addEventListener('click', onResetLayout)
  document.querySelector('#layout-close-gaps').addEventListener('click', onCloseGaps)
  document.querySelector('#settings-open').addEventListener('click', () => dialog.showModal())
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close()
  })
}
