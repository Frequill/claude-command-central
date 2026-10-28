import type { AgentRun } from '../types'

import { STATUS_COLOR, STATUS_WORD, clip, runTime } from './format'

const WIDTH = 380
const ROOT = { x: 8, w: 104, h: 40 }
const NODE = { x: 156, w: 216, h: 46, gap: 10 }
const PAD = 8

/** The agent map as an SVG document: this session on the left, one node per run. */
export function agentMapSvg(runs: readonly AgentRun[], now: number): string {
  const height = Math.max(ROOT.h, runs.length * (NODE.h + NODE.gap) - NODE.gap) + PAD * 2
  const rootY = height / 2 - ROOT.h / 2
  const nodes = runs.map((run, i) => drawRun(run, PAD + i * (NODE.h + NODE.gap), rootY, now))

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" font-family="system-ui, sans-serif">`,
    STYLE,
    `<rect x="${ROOT.x}" y="${rootY}" width="${ROOT.w}" height="${ROOT.h}" rx="10" fill="#334155"/>`,
    `<text x="${ROOT.x + ROOT.w / 2}" y="${rootY + 25}" class="root">This session</text>`,
    ...nodes,
    '</svg>',
  ].join('')
}

export function agentMapAlt(runs: readonly AgentRun[]): string {
  if (runs.length === 0) return 'No agents'
  return runs.map(run => `${run.label}: ${STATUS_WORD[run.status]}`).join(', ')
}

const STYLE =
  '<style>' +
  'text{fill:#fff}' +
  '.root{font-size:11px;font-weight:600;text-anchor:middle}' +
  '.label{font-size:12px;font-weight:600}' +
  '.meta{font-size:10px;opacity:.85}' +
  '.edge{fill:none;stroke:#94a3b8;stroke-width:1.5}' +
  '.live{stroke:#3b82f6;stroke-dasharray:6 4;animation:flow 1s linear infinite}' +
  '@keyframes flow{to{stroke-dashoffset:-10}}' +
  '.pulse{animation:pulse 1.2s ease-in-out infinite}' +
  '@keyframes pulse{50%{opacity:.25}}' +
  '</style>'

function drawRun(run: AgentRun, y: number, rootY: number, now: number): string {
  const isLive = run.status === 'running'
  const fromX = ROOT.x + ROOT.w
  const fromY = rootY + ROOT.h / 2
  const toY = y + NODE.h / 2
  const bend = (NODE.x - fromX) / 2
  const edge = `M${fromX} ${fromY} C${fromX + bend} ${fromY} ${NODE.x - bend} ${toY} ${NODE.x} ${toY}`
  const meta = `${STATUS_WORD[run.status]} · ${runTime(run, now)}`
  const action = run.lastAction ? ` · ${run.lastAction}` : ''

  return [
    `<path d="${edge}" class="edge${isLive ? ' live' : ''}"/>`,
    `<rect x="${NODE.x}" y="${y}" width="${NODE.w}" height="${NODE.h}" rx="8" fill="${STATUS_COLOR[run.status]}"/>`,
    isLive ? `<circle cx="${NODE.x + NODE.w - 12}" cy="${y + 12}" r="4" fill="#fff" class="pulse"/>` : '',
    `<text x="${NODE.x + 10}" y="${y + 18}" class="label">${escape(clip(run.label, 26))}</text>`,
    `<text x="${NODE.x + 10}" y="${y + 35}" class="meta">${escape(clip(meta + action, 40))}</text>`,
  ].join('')
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
