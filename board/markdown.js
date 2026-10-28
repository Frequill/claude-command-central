// The little Markdown Claude writes, read into plain blocks the chat window draws with
// textContent: paragraphs, headings, lists, tables, quotes and code. No HTML is ever passed on.

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
      const items = []
      while (i < lines.length && listItem(lines[i])?.ordered === item.ordered) {
        const next = listItem(lines[i])
        const text = [next.text]
        i += 1
        while (i < lines.length && lines[i].trim() && !listItem(lines[i]) && /^\s{2,}/.test(lines[i])) text.push(lines[i++].trim())
        items.push(inline(text.join(' ')))
      }
      out.push({ type: 'list', ordered: item.ordered, start: item.start, items })
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

function listItem(line) {
  const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line)
  if (bullet) return { ordered: false, text: bullet[1] }
  const number = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/.exec(line)
  if (number) return { ordered: true, start: Number(number[1]), text: number[2] }
  return null
}

function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line)
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
}

/**
 * The spans of a line: `{ t: 'text' | 'strong' | 'em' | 'code' | 'link', text, href? }`. A link
 * keeps its address only when it is http or https.
 */
export function inline(text) {
  const spans = []
  const pattern = /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\[([^\]\n]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g
  let last = 0
  for (const match of String(text ?? '').matchAll(pattern)) {
    if (match.index > last) spans.push({ t: 'text', text: text.slice(last, match.index) })
    if (match[1]) spans.push({ t: 'code', text: match[2].trim() })
    else if (match[3] !== undefined || match[4] !== undefined) spans.push({ t: 'strong', text: match[3] ?? match[4] })
    else if (match[5] !== undefined) spans.push(/^https?:\/\//i.test(match[6]) ? { t: 'link', text: match[5], href: match[6] } : { t: 'text', text: match[5] })
    else spans.push({ t: 'em', text: match[7] })
    last = match.index + match[0].length
  }
  if (last < String(text ?? '').length) spans.push({ t: 'text', text: text.slice(last) })
  return spans
}
