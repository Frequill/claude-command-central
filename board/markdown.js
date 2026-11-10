// The little Markdown Claude and the person write, read into plain blocks the chat window draws
// with textContent: paragraphs, headings, lists (nested, and tasks), tables, quotes and code. No HTML
// is ever passed on.

/** Blocks of a text: `{ type: 'paragraph' | 'heading' | 'list' | 'table' | 'quote' | 'code' | 'rule', ... }`. */
export function blocks(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // a fence of three or more backticks (or tildes) with an optional language; it closes on a fence of
    // the same mark at least as long, so a block can hold a shorter fence of its own (Markdown in Markdown)
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/.exec(line)
    if (fence) {
      const mark = fence[1][0]
      const closes = new RegExp(`^\\s{0,3}\\${mark}{${fence[1].length},}\\s*$`)
      const body = []
      i += 1
      while (i < lines.length && !closes.test(lines[i])) body.push(lines[i++])
      i += 1
      out.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') })
      continue
    }
    if (!line.trim()) {
      i += 1
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      out.push({ type: 'heading', level: heading[1].length, inline: inline(heading[2].replace(/\s#+\s*$/, '')) })
      i += 1
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ type: 'rule' })
      i += 1
      continue
    }
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const rows = [cells(line)]
      i += 2
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]))
      out.push({ type: 'table', head: rows[0].map(inline), rows: rows.slice(1).map(row => row.map(inline)) })
      continue
    }
    if (/^\s*>/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      out.push({ type: 'quote', blocks: blocks(body.join('\n')) })
      continue
    }
    const item = listItem(line)
    if (item) {
      const read = readList(lines, i, item.indent)
      out.push(read.list)
      i = read.next
      continue
    }
    const body = []
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) body.push(lines[i++])
    if (body.length === 0) body.push(lines[i++])
    out.push({ type: 'paragraph', inline: inline(body.join('\n')) })
  }
  return out
}

function startsBlock(lines, i) {
  const line = lines[i]
  return (
    /^\s{0,3}(`{3,}|~{3,})/.test(line) ||
    /^\s{0,3}#{1,6}\s/.test(line) ||
    /^\s*>/.test(line) ||
    Boolean(listItem(line)) ||
    (isTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]))
  )
}

/**
 * A list from line `i` on, its items at indent `base`: `{ list, next }`, `next` the first line after
 * it. A list line indented two or more spaces past an item is a list of its own inside that item
 * (`nested`, one entry per item, null for an item with none); other indented lines go on with the
 * item's words. An item that starts with "[ ]" or "[x]" is a task, drawn with its box.
 */
function readList(lines, i, base) {
  const first = itemAt(lines[i])
  const items = []
  const nested = []
  while (i < lines.length) {
    const next = itemAt(lines[i])
    if (!next || next.ordered !== first.ordered || next.indent < base || next.indent >= base + 2) break
    const text = [next.text]
    let inside = null
    i += 1
    while (i < lines.length && lines[i].trim()) {
      const inner = itemAt(lines[i])
      if (inner && inner.indent >= base + 2) {
        const read = readList(lines, i, inner.indent)
        inside = [...(inside ?? []), read.list]
        i = read.next
      } else if (!inner && /^\s{2,}/.test(lines[i])) text.push(lines[i++].trim())
      else break
    }
    items.push(itemSpans(text.join(' ')))
    nested.push(inside)
  }
  const list = { type: 'list', ordered: first.ordered, start: first.start, items }
  if (nested.some(Boolean)) list.nested = nested
  return { list, next: i }
}

function itemSpans(text) {
  const task = /^\[([ xX])\]\s+/.exec(text)
  return task ? [{ t: 'box', done: task[1] !== ' ' }, ...inline(text.slice(task[0].length))] : inline(text)
}

/** A list line at any indent: `{ indent, ordered, start, text }`, or null. */
function itemAt(line) {
  const found = /^( *)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/.exec(line ?? '')
  if (!found) return null
  return { indent: found[1].length, ordered: !found[2], start: found[3] === undefined ? undefined : Number(found[3]), text: found[4] }
}

/** A list line that starts a list: indented three spaces at most, as Markdown has it. */
function listItem(line) {
  const item = itemAt(line)
  return item && item.indent <= 3 ? item : null
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line)
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
}

/**
 * The spans of a line: `{ t: 'text' | 'strong' | 'em' | 'del' | 'code' | 'link', text, href? }`. A link
 * keeps its address only when it is http or https. An address written as it is (https://…, or
 * <https://…>) is a link too, without the full stop or bracket that ends the sentence around it.
 */
export function inline(text) {
  const spans = []
  const pattern = /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\[([^\]\n]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|<(https?:\/\/[^\s<>]+)>|(?<![\w/])(https?:\/\/[^\s<>"'`]+)|~~(?!\s)([^~\n]+?)~~|(?<![\w_])_(?![\s_])([^_\n]+?)_(?![\w_])/gi
  let last = 0
  for (const match of String(text ?? '').matchAll(pattern)) {
    if (match.index > last) spans.push({ t: 'text', text: text.slice(last, match.index) })
    if (match[1]) spans.push({ t: 'code', text: match[2].trim() })
    else if (match[3] !== undefined || match[4] !== undefined) spans.push({ t: 'strong', text: match[3] ?? match[4] })
    else if (match[5] !== undefined) spans.push(/^https?:\/\//i.test(match[6]) ? { t: 'link', text: match[5], href: match[6] } : { t: 'text', text: match[5] })
    else if (match[8] !== undefined) spans.push({ t: 'link', text: match[8], href: match[8] })
    else if (match[9] !== undefined) {
      const address = bareAddress(match[9])
      spans.push({ t: 'link', text: address, href: address })
      // what was cut off the end goes on as words
      last = match.index + address.length
      continue
    } else if (match[10] !== undefined) spans.push({ t: 'del', text: match[10] })
    else spans.push({ t: 'em', text: match[7] ?? match[11] })
    last = match.index + match[0].length
  }
  if (last < String(text ?? '').length) spans.push({ t: 'text', text: text.slice(last) })
  return spans
}

/**
 * An address written in the words, without what ends the sentence around it: a full stop, comma or
 * the like, and a closing bracket that has no opening one in the address.
 */
function bareAddress(found) {
  let address = found
  for (;;) {
    const end = address.at(-1)
    if ('.,;:!?*_\''.includes(end)) address = address.slice(0, -1)
    else if (end === ')' && (address.match(/\(/g)?.length ?? 0) < (address.match(/\)/g)?.length ?? 0)) address = address.slice(0, -1)
    else if (end === ']' && !address.includes('[')) address = address.slice(0, -1)
    else return address
  }
}
