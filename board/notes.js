// The notes panel: one free text box beside the board that saves itself as the person types.

const SAVE_DELAY_MS = 500

/** Wires the notes box; it reloads when the window comes back, unless the person is typing. */
export function setupNotes() {
  const box = document.querySelector('#notes-text')
  let saved = ''
  let timer = 0

  const save = () => {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      timer = 0
      const text = box.value
      if (text === saved) return
      try {
        const response = await fetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CCC-Action': 'notes' },
          body: JSON.stringify({ text }),
        })
        if (response.ok) saved = text
      } catch {
        // the next keystroke tries again
      }
    }, SAVE_DELAY_MS)
  }

  const load = async () => {
    if (timer || document.activeElement === box) return
    try {
      const response = await fetch('/api/notes', { cache: 'no-store' })
      if (!response.ok) return
      const { text } = await response.json()
      if (typeof text === 'string' && document.activeElement !== box && !timer) {
        box.value = text
        saved = text
      }
    } catch {
      // the server is away: keep what is on screen
    }
  }

  box.addEventListener('input', save)
  box.addEventListener('blur', save)
  window.addEventListener('focus', load)
  load()
}
