import { expect, test } from 'claude-code/testing'

import type { Snapshot } from '../types'
import { describe, diffRows, fmt, summarize } from './register'

const prev = {
  rows: [
    { name: 'Skills', kind: 'used', color: 'x', tokens: 3000, delta: 0 },
    { name: 'Messages', kind: 'used', color: 'x', tokens: 10000, delta: 0 },
    { name: 'Free space', kind: 'free', color: 'x', tokens: 50000, delta: 0 },
  ],
} as unknown as Snapshot

test('a skill call is named by the skill it loads', () => {
  expect(describe('Skill', { skill: 'plugin-authoring' })).toBe('Skill(plugin-authoring)')
  expect(describe('ToolSearch', { query: 'select:WebFetch' })).toBe('ToolSearch(select:WebFetch)')
  expect(describe('Read', { file_path: 'C:\\a\\b\\CLAUDE.md' })).toBe('Read(CLAUDE.md)')
  expect(describe('Bash', { command: 'ls' })).toBe('Bash')
})

test('deltas are per row against the previous snapshot', () => {
  const rows = diffRows(
    [
      { name: 'Skills', kind: 'used', color: 'x', tokens: 4200 },
      { name: 'Messages', kind: 'used', color: 'x', tokens: 10050 },
      { name: 'Free space', kind: 'free', color: 'x', tokens: 48750 },
      { name: 'MCP tools', kind: 'deferred', color: 'x', tokens: 900 },
    ],
    prev,
  )
  expect(rows.map(r => r.delta)).toEqual([1200, 50, -1250, 0])
})

test('the shift summary keeps used rows past the noise floor', () => {
  const rows = diffRows(
    [
      { name: 'Skills', kind: 'used', color: 'x', tokens: 4200 },
      { name: 'Messages', kind: 'used', color: 'x', tokens: 10050 },
      { name: 'Free space', kind: 'free', color: 'x', tokens: 48750 },
    ],
    prev,
  )
  expect(summarize(rows)).toBe('Skills +1.2k')
})

test('a first snapshot has no deltas', () => {
  const rows = diffRows([{ name: 'Skills', kind: 'used', color: 'x', tokens: 4200 }], null)
  expect(summarize(rows)).toBe('')
  expect(fmt(950)).toBe('950')
})
