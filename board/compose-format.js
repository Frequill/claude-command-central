// Markdown typing help for the write box, as the Claude app's prompt box gives it: Shift+Enter
// goes on with a list or a quote, numbered lists keep their numbers in order, Tab moves list lines
// in and out, ⌘B and the like wrap what is selected, a code fence closes itself, and what is pasted
// from a web page or a document keeps its lists, bold and links. Claude gets Markdown either way.
//
// Each helper takes the box as { value, start, end } (its text and selection) and gives back the
// box as it should be after the key, or null when the key should do what it always does. Nothing
// here touches the page, so every rule can be tested on plain text.

// a list line: its indent, then "-", "*" or "+", or a number with "." or ")", then a space, and a
// task box ("[ ] " or "[x] ") if it has one
const ITEM = /^( *)(?:([-*+])|(\d{1,9})([.)]))( +)(\[[ xX]\] +)?/
// a line that is only a list marker, with nothing after it yet: "1.", "2)" or "-"
const BARE_MARKER = /^( *)(?:([-*+])|(\d{1,9})([.)]))$/
// a quote line: one or more ">" marks
const QUOTE = /^( *)((?:> ?)+)/
// a line that opens or closes a code block
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** One list line read into its parts, or null when the line is not a list line. */
export function listItem(line) {
  const m = ITEM.exec(line)
  if (!m) return null
  return {
    indent: m[1].length,
    bullet: m[2] ?? '',
    number: m[3] === undefined ? null : Number(m[3]),
    delimiter: m[4] ?? '',
    gap: m[5],
    task: m[6] ?? '',
    // where the words of the item start
    end: m[0].length,
  }
}

/** The line the position is on: where it starts and ends, and its text. */
function lineAt(value, at) {
  const start = at === 0 ? 0 : value.lastIndexOf('\n', at - 1) + 1
  const found = value.indexOf('\n', at)
  const end = found < 0 ? value.length : found
  return { start, end, text: value.slice(start, end) }
}

/** Whether a code block is open where this line starts: then Markdown rules do not apply inside it. */
export function isInCode(value, lineStart) {
  let open = null
  for (const line of value.slice(0, lineStart).split('\n').slice(0, -1)) {
    const fence = FENCE.exec(line)
    if (!fence) continue
    if (!open) open = fence[1]
    // it closes on a fence of the same mark at least as long, with nothing after it
    else if (fence[1][0] === open[0] && fence[1].length >= open.length && !line.slice(fence[0].length).trim()) open = null
  }
  return open !== null
}

/** Whether the position is inside a code block. */
export function isInCodeAt(value, at) {
  return isInCode(value, lineAt(value, at).start)
}

/** The text with `from`..`to` replaced, and the cursor (or selection) where it is asked to be. */
function replace(value, from, to, text, start, end = start) {
  return { value: value.slice(0, from) + text + value.slice(to), start, end }
}

/**
 * Shift+Enter. In a list it starts the next item with the next marker (and an empty task box after
 * a task), on an empty item too, so the numbers can go down first and the words in after; a line
 * that is only "1." or "-" starts a list the same way. Backspace over the marker ends the list. In a
 * quote it starts the next quoted line, and on an empty one it ends the quote. In a code block the
 * new line keeps the indent of the one above. Anywhere else it is a plain new line.
 */
export function newLine(box) {
  const { value, start, end } = box
  if (start !== end) return null
  const line = lineAt(value, start)
  const before = value.slice(line.start, start)
  if (isInCode(value, line.start) || FENCE.test(line.text)) {
    const indent = /^[ \t]*/.exec(before)[0]
    if (!indent) return null
    return replace(value, start, start, `\n${indent}`, start + 1 + indent.length)
  }
  // a line that is only a marker, "1." or "-", and the cursor after it: the list starts here
  const bare = BARE_MARKER.exec(line.text)
  if (bare && start === line.end) {
    const marker = bare[3] === undefined ? bare[2] : `${Number(bare[3]) + 1}${bare[4]}`
    const text = `${line.text} \n${bare[1]}${marker} `
    return renumber(replace(value, line.start, line.end, text, line.start + text.length))
  }
  const item = listItem(line.text)
  if (item && start >= line.start + item.end) {
    const marker = item.number === null ? item.bullet : `${item.number + 1}${item.delimiter}`
    const next = `\n${' '.repeat(item.indent)}${marker}${item.gap}${item.task ? '[ ] ' : ''}`
    return renumber(replace(value, start, start, next, start + next.length))
  }
  const quote = QUOTE.exec(line.text)
  if (quote && start >= line.start + quote[0].length) {
    if (!line.text.slice(quote[0].length).trim()) return replace(value, line.start, line.end, '', line.start)
    const next = `\n${quote[1]}${quote[2].replace(/ ?$/, ' ')}`
    return replace(value, start, start, next, start + next.length)
  }
  return null
}

/**
 * Tab, or Shift+Tab with `isOut`: moves the lines the selection touches in or out. A list item
 * goes under the item above it, as far in as that item's words start, or back out to its parent.
 * Other lines move two spaces. Only for list lines, lines in a code block, or a selection over
 * several lines: anywhere else Tab moves on to the next button, as it always does.
 */
export function indentLines(box, isOut = false) {
  const { value, start, end } = box
  const first = lineAt(value, start)
  // a selection that ends at the very start of a line does not take that line along
  const last = lineAt(value, end > start && value[end - 1] === '\n' ? end - 1 : end)
  const lines = value.slice(first.start, last.end).split('\n')
  const isSeveral = lines.length > 1
  const item = listItem(first.text)
  if (!isSeveral && !item && !isInCode(value, first.start)) return null
  const above = value.slice(0, first.start).split('\n').slice(0, -1)
  const lead = /^ */.exec(first.text)[0].length
  const step = item ? itemStep(above, lead, isOut) : isOut ? -Math.min(2, lead) : 2
  // already as far out as it goes: the key is taken all the same, so the cursor stays in the box
  if (step === 0) return { ...box }
  const moved = lines.map(line => {
    if (!line.trim()) return line
    if (step > 0) return ' '.repeat(step) + line
    return line.slice(Math.min(-step, /^ */.exec(line)[0].length))
  })
  const text = moved.join('\n')
  const next = isSeveral
    ? replace(value, first.start, last.end, text, first.start, first.start + text.length)
    : (() => {
        const caret = Math.max(first.start, start + (moved[0].length - lines[0].length))
        return replace(value, first.start, last.end, text, caret)
      })()
  return renumber(next)
}

/**
 * How far a list item at indent `lead` moves: in, to where the words of the item above it at the
 * same level start; out, back to its parent item's indent.
 */
function itemStep(above, lead, isOut) {
  for (let k = above.length - 1; k >= 0; k--) {
    const line = above[k]
    if (!line.trim()) break
    const item = listItem(line)
    if (!item || item.indent > lead) continue
    // out: past the items at its own level, to the parent's
    if (isOut) {
      if (item.indent < lead) return item.indent - lead
      continue
    }
    return item.indent === lead ? item.end - item.task.length - item.indent : 2
  }
  return isOut ? -Math.min(2, lead) : 2
}

/**
 * Puts the numbered lists around the cursor back in order, as the app keeps them: each item one
 * more than the one before it at its level. The first item of a list keeps its own number, unless
 * it is nested under another item, where it starts at 1. Only the lines next to the cursor's, up
 * to a blank line, are looked at, so a list somewhere else in the text is left as it was written.
 */
export function renumber(box) {
  const { value } = box
  const lines = value.split('\n')
  const at = value.slice(0, box.start).split('\n').length - 1
  let top = at
  while (top > 0 && lines[top - 1].trim()) top -= 1
  let bottom = at
  while (bottom < lines.length - 1 && lines[bottom + 1].trim()) bottom += 1
  // the number each level is at: { indent: number, or null after a bullet }
  const levels = new Map()
  const changes = []
  let offset = lines.slice(0, top).reduce((sum, line) => sum + line.length + 1, 0)
  let inCode = isInCode(value, offset)
  for (let k = top; k <= bottom; k++) {
    const line = lines[k]
    const lineStart = offset
    offset += line.length + 1
    if (FENCE.test(line)) inCode = !inCode
    if (inCode || FENCE.test(line)) continue
    const item = listItem(line)
    if (!item) {
      if (!/^ /.test(line)) levels.clear()
      continue
    }
    for (const indent of levels.keys()) if (indent > item.indent) levels.delete(indent)
    if (item.number === null) {
      levels.set(item.indent, null)
      continue
    }
    const before = levels.get(item.indent)
    const hasParent = [...levels.keys()].some(indent => indent < item.indent)
    const number = typeof before === 'number' ? before + 1 : hasParent ? 1 : item.number
    levels.set(item.indent, number)
    if (number !== item.number) changes.push({ at: lineStart + item.indent, old: String(item.number).length, text: String(number) })
  }
  if (changes.length === 0) return box
  let text = value
  let { start, end } = box
  for (const change of changes.reverse()) {
    text = text.slice(0, change.at) + change.text + text.slice(change.at + change.old)
    const grown = change.text.length - change.old
    if (start > change.at) start = Math.max(change.at, start + grown)
    if (end > change.at) end = Math.max(change.at, end + grown)
  }
  return { value: text, start, end }
}

/**
 * Wraps the selection in a Markdown mark (`**` bold, `*` italic, `~~` strikethrough, `` ` `` code),
 * or takes the mark off when the selection is wrapped in it already. With nothing selected the two
 * marks go in with the cursor between them. `isToggle` false only ever wraps: typing `*` over
 * italic words makes them bold.
 */
export function wrap(box, mark, isToggle = true) {
  const { value, start, end } = box
  const size = mark.length
  const inner = value.slice(start, end)
  if (isToggle && inner.length >= 2 * size && inner.startsWith(mark) && inner.endsWith(mark)) {
    return replace(value, start, end, inner.slice(size, -size), start, end - 2 * size)
  }
  // a single "*" just outside is italic only when it is not part of "**" around it
  const isOwnMark = size > 1 || (value[start - size - 1] !== mark && value[end + size] !== mark)
  if (isToggle && start >= size && value.slice(start - size, start) === mark && value.slice(end, end + size) === mark && isOwnMark) {
    return replace(value, start - size, end + size, inner, start - size, end - size)
  }
  return replace(value, start, end, mark + inner + mark, start + size, end + size)
}

/**
 * Right after a third backtick (or tilde) typed at the start of a line, the block's closing fence
 * goes on the line below, and the cursor stays where the language is written. Not when the fence
 * typed closes a block that is open.
 */
export function closeFence(box) {
  const { value, start, end } = box
  if (start !== end) return null
  const line = lineAt(value, start)
  const typed = value.slice(line.start, start)
  if (!/^ {0,3}(```|~~~)$/.test(typed) || value.slice(start, line.end).trim() || isInCode(value, line.start)) return null
  const indent = /^ */.exec(typed)[0]
  return replace(value, start, start, `\n${indent}${typed.trim()}`, start)
}

/** A web address pasted over selected words, on one line: a Markdown link with those words. */
export function linkOver(box, pasted) {
  const address = String(pasted ?? '').trim()
  const { value, start, end } = box
  const words = value.slice(start, end)
  if (start === end || words.includes('\n') || !/^https?:\/\/\S+$/i.test(address)) return null
  const text = `[${words.replace(/[[\]]/g, '\\$&')}](${address.replace(/\)/g, '%29')})`
  return replace(value, start, end, text, start + text.length)
}

/** The text with `pasted` put in place of the selection, the cursor after it. */
export function insertText(box, pasted) {
  return replace(box.value, box.start, box.end, pasted, box.start + pasted.length)
}

// ---------- pasted from a web page or a document ----------

const SKIPPED = new Set(['SCRIPT', 'STYLE', 'HEAD', 'META', 'TITLE', 'LINK', 'NOSCRIPT', 'TEMPLATE', 'IMG', 'SVG', 'BUTTON', 'SELECT', 'TEXTAREA'])
const PLAIN_BLOCKS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'BODY', 'HTML', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'CENTER', 'DL', 'DT', 'DD', 'TR', 'TD', 'TH', 'TBODY', 'THEAD', 'TFOOT'])
const MARKED_BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'TABLE', 'HR'])

/**
 * What was copied from a web page or a document, as Markdown: its headings, lists (and task
 * boxes), quotes, code, tables, bold, italic, strikethrough and links. null when it holds none of
 * those, so a plain paste (from a terminal or an editor) goes in as the text it is. `root` is the
 * parsed page's body (DOMParser, where nothing runs or loads); only what it reads is used: each
 * node's nodeType, nodeName, childNodes, textContent, and an element's getAttribute and style.
 */
export function markdownOfHtml(root) {
  const found = { isFormatted: false }
  const text = blockChildren(root, { found, inList: false, inPre: false }).replace(/\n{3,}/g, '\n\n').trim()
  return found.isFormatted && text ? text : null
}

/** A node's children as Markdown blocks: runs of words between blocks become lines of their own. */
function blockChildren(node, context) {
  const parts = []
  let run = ''
  const flush = () => {
    const text = run.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
    if (text) parts.push({ text, gap: '\n' })
    run = ''
  }
  for (const child of node.childNodes ?? []) {
    const block = blockOf(child, context)
    if (block === null) {
      run += inlineOf(child, context)
      continue
    }
    flush()
    if (block.text) parts.push(block)
  }
  flush()
  return parts.reduce((out, part, i) => (i === 0 ? part.text : `${out}${part.gap === '\n\n' || parts[i - 1].gap === '\n\n' ? '\n\n' : '\n'}${part.text}`), '')
}

function isElement(node) {
  return node?.nodeType === 1
}

function hasBlockInside(node) {
  return [...(node.childNodes ?? [])].some(child => isElement(child) && (PLAIN_BLOCKS.has(child.nodeName) || MARKED_BLOCKS.has(child.nodeName) || hasBlockInside(child)))
}

/** A block element as `{ text, gap }`, the gap a blank line or a line break; null for words. */
function blockOf(node, context) {
  if (!isElement(node)) return null
  const tag = node.nodeName
  const { found } = context
  const gap = context.inList ? '\n' : '\n\n'
  if (SKIPPED.has(tag)) return null
  if (/^H[1-6]$/.test(tag)) {
    found.isFormatted = true
    const words = blockChildren(node, context).replace(/\s*\n\s*/g, ' ')
    return { text: words ? `${'#'.repeat(Number(tag[1]))} ${words}` : '', gap }
  }
  if (tag === 'P') return { text: blockChildren(node, context), gap }
  if (tag === 'UL' || tag === 'OL') return { text: listOf(node, context), gap }
  if (tag === 'LI') return { text: itemOf(node, '- ', context), gap: '\n' }
  if (tag === 'PRE') {
    found.isFormatted = true
    const code = String(node.textContent ?? '').replace(/\n$/, '')
    const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map(run => run.length))
    const fence = '`'.repeat(Math.max(3, longest + 1))
    const language = languageOf(node)
    return { text: `${fence}${language}\n${code}\n${fence}`, gap }
  }
  if (tag === 'BLOCKQUOTE') {
    found.isFormatted = true
    const inner = blockChildren(node, { ...context, inList: false })
    return { text: inner.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n'), gap }
  }
  if (tag === 'TABLE') return { text: tableOf(node, context), gap }
  if (tag === 'HR') {
    found.isFormatted = true
    return { text: '---', gap }
  }
  if (PLAIN_BLOCKS.has(tag)) return { text: blockChildren(node, context), gap: '\n' }
  // a bold or link wrapped around whole paragraphs (as Google Docs copies) holds blocks: read through it
  if (hasBlockInside(node)) return { text: blockChildren(node, context), gap: '\n' }
  return null
}

function listOf(node, context) {
  context.found.isFormatted = true
  const isOrdered = node.nodeName === 'OL'
  const first = Number.parseInt(node.getAttribute?.('start') ?? '', 10)
  let number = Number.isFinite(first) ? first : 1
  const lines = []
  for (const child of node.childNodes ?? []) {
    if (!isElement(child)) continue
    if (child.nodeName !== 'LI') {
      // a list put straight inside a list (as some pages do): it belongs to the item above
      const nested = blockOf(child, { ...context, inList: true })
      if (nested?.text) lines.push(nested.text.split('\n').map(line => (line ? `   ${line}` : line)).join('\n'))
      continue
    }
    lines.push(itemOf(child, isOrdered ? `${number++}. ` : '- ', context))
  }
  return lines.join('\n')
}

/** A list item: its marker, a task box if it has a checkbox, and its words, the lines under it indented to them. */
function itemOf(node, marker, context) {
  const box = checkboxIn(node)
  const words = blockChildren(node, { ...context, inList: true })
  const checked = box?.getAttribute?.('checked')
  const task = box ? (checked === null || checked === undefined ? '[ ] ' : '[x] ') : ''
  const pad = ' '.repeat(marker.length)
  return `${marker}${task}${words.split('\n').map((line, i) => (i === 0 || !line ? line : pad + line)).join('\n')}`
}

/** The checkbox a task item starts with, if any: among its first few nodes. */
function checkboxIn(node, depth = 0) {
  for (const child of node.childNodes ?? []) {
    if (!isElement(child)) continue
    if (child.nodeName === 'INPUT' && String(child.getAttribute?.('type')).toLowerCase() === 'checkbox') return child
    if (depth < 2 && !['UL', 'OL'].includes(child.nodeName)) {
      const inner = checkboxIn(child, depth + 1)
      if (inner) return inner
    }
  }
  return null
}

function languageOf(node) {
  for (const one of [node, ...(node.childNodes ?? [])]) {
    const name = isElement(one) ? String(one.getAttribute?.('class') ?? '') : ''
    const found = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(name)
    if (found) return found[1]
  }
  return ''
}

function tableOf(node, context) {
  context.found.isFormatted = true
  const rows = []
  const collect = parent => {
    for (const child of parent.childNodes ?? []) {
      if (!isElement(child)) continue
      if (child.nodeName === 'TR') rows.push([...child.childNodes].filter(cell => isElement(cell) && (cell.nodeName === 'TD' || cell.nodeName === 'TH')))
      else if (['THEAD', 'TBODY', 'TFOOT'].includes(child.nodeName)) collect(child)
    }
  }
  collect(node)
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map(row => row.length))
  const line = cells => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`
  const texts = rows.map(row => row.map(cell => blockChildren(cell, context).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')))
  return [line(texts[0]), line(Array(width).fill('---')), ...texts.slice(1).map(line)].join('\n')
}

/** Words and inline marks: bold, italic, strikethrough, code and links. */
function inlineOf(node, context) {
  if (node?.nodeType === 3) return String(node.textContent ?? '').replace(/\s+/g, ' ')
  if (!isElement(node) || SKIPPED.has(node.nodeName)) return ''
  const tag = node.nodeName
  if (tag === 'BR') return '\n'
  if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') {
    const code = String(node.textContent ?? '').replace(/\s*\n\s*/g, ' ')
    if (!code.trim()) return code
    context.found.isFormatted = true
    const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map(run => run.length))
    const tick = '`'.repeat(longest + 1)
    return longest ? `${tick} ${code} ${tick}` : `${tick}${code}${tick}`
  }
  const words = [...(node.childNodes ?? [])].map(child => inlineOf(child, context)).join('')
  if (tag === 'A') {
    const href = String(node.getAttribute?.('href') ?? '')
    if (!/^(https?:|mailto:)/i.test(href) || !words.trim()) return words
    context.found.isFormatted = true
    if (words.trim() === href) return words
    return around(words, core => `[${core.replace(/\n/g, ' ')}](${href.replace(/\)/g, '%29')})`)
  }
  const style = node.style ?? {}
  const weight = String(style.fontWeight ?? '')
  const isBold = ((tag === 'B' || tag === 'STRONG') && weight !== 'normal' && !(Number(weight) > 0 && Number(weight) < 600)) || weight === 'bold' || Number(weight) >= 600
  const isItalic = tag === 'I' || tag === 'EM' || String(style.fontStyle ?? '') === 'italic'
  const isStruck = tag === 'S' || tag === 'DEL' || tag === 'STRIKE' || String(style.textDecoration ?? style.textDecorationLine ?? '').includes('line-through')
  let out = words
  if (isStruck) out = marked(out, '~~', context)
  if (isItalic) out = marked(out, '*', context)
  if (isBold) out = marked(out, '**', context)
  return out
}

/** Words wrapped in a mark, the spaces around them left outside it, as Markdown needs. */
function marked(words, mark, context) {
  if (!words.trim()) return words
  context.found.isFormatted = true
  return around(words, core => `${mark}${core}${mark}`)
}

function around(words, make) {
  const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(words)
  return `${parts[1]}${make(parts[2])}${parts[3]}`
}
