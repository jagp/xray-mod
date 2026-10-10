import { expect, test } from 'claude-code/testing'

import type { Tally } from '../types'
import { buildTable, reconcile } from './contributions'
import type { BreakdownInput, Node } from './contributions'

// A window shaped like /context's: 100k used, of which Messages is 40k.
const BREAKDOWN: BreakdownInput = {
  categories: [
    { name: 'System prompt', kind: 'used', tokens: 8_000 },
    { name: 'System tools', kind: 'used', tokens: 12_000 },
    { name: 'MCP tools', kind: 'used', tokens: 10_000 },
    { name: 'Skills', kind: 'used', tokens: 25_000 },
    { name: 'Memory files', kind: 'used', tokens: 5_000 },
    { name: 'Messages', kind: 'used', tokens: 40_000 },
    { name: 'Free space', kind: 'free', tokens: 80_000 },
    { name: 'Autocompact buffer', kind: 'buffer', tokens: 20_000 },
    { name: 'MCP tools (deferred)', kind: 'deferred', tokens: 9_000 },
  ],
  skills: { skillFrontmatter: [{ name: 'plugin-authoring', tokens: 200 }, { name: 'namesmith', tokens: 455 }] },
  mcpTools: [
    { serverName: 'linear', tokens: 6_000, isLoaded: true },
    { serverName: 'linear', tokens: 4_000, isLoaded: true },
    { serverName: 'notion', tokens: 9_000, isLoaded: false }, // deferred: outside the window
  ],
  memoryFiles: [{ path: 'C:/x/CLAUDE.md', tokens: 5_000 }],
  agents: [{ agentType: 'Explore', tokens: 300 }],
}

const tally = (entries: [Tally['source'], string, number, number?, boolean?][]): Record<string, Tally> =>
  Object.fromEntries(
    entries.map(([source, item, chars, calls = 0, isInferred = false]) => [
      `${source}:${item}`,
      { source, item, chars, calls, isInferred },
    ]),
  )

const node = (nodes: Node[], key: string) => nodes.find(one => one.key === key)
const sum = (nodes: Node[]) => nodes.reduce((total, one) => total + one.static + one.active, 0)

test('static + active + unattributed add up to the used total', () => {
  const table = buildTable(BREAKDOWN, tally([['skill', 'plugin-authoring', 40_000, 1, true], ['tool', 'Bash', 8_000, 7]]))
  expect(table.total).toBe(100_000)
  expect(Math.abs(sum(table.nodes) - table.total)).toBeLessThanOrEqual(table.total * 0.01)
})

test('a tally that started late leaves an honest gap, never inflated', () => {
  // 12k known tokens against a 40k Messages row: nothing scales up.
  const table = buildTable(BREAKDOWN, tally([['assistant', 'text', 48_000]]))
  expect(table.scale).toBe(1)
  expect(node(table.nodes, 'conversation')?.active).toBe(12_000)
  expect(node(table.nodes, 'unattributed')?.active).toBe(28_000)
})

test('estimates above Messages are scaled down to fit it exactly', () => {
  // 50k estimated against 40k: every item shrinks by the same 0.8.
  const table = buildTable(BREAKDOWN, tally([['tool', 'Read', 120_000], ['tool', 'Bash', 80_000]]))
  expect(reconcile(50_000, 40_000)).toBe(0.8)
  expect(node(table.nodes, 'tool')?.active).toBe(40_000)
  expect(node(table.nodes, 'unattributed')).toBe(undefined)
})

test("a skill's listing and its calls share one row; a call-only skill gets its own", () => {
  const table = buildTable(BREAKDOWN, tally([['skill', 'plugin-authoring', 36_000, 1, true], ['skill', 'docs', 400, 1]]))
  const skills = node(table.nodes, 'skill')
  const authoring = skills?.children.find(child => child.label === 'plugin-authoring')
  expect(authoring).toMatchObject({ static: 200, active: 9_000, calls: 1, isInferred: true })
  expect(skills?.children.find(child => child.label === 'docs')).toMatchObject({ static: 0, active: 100 })
  expect(skills?.children[0]?.label).toBe('plugin-authoring') // largest first
})

test('MCP static groups by server and leaves deferred schemas out', () => {
  const mcp = node(buildTable(BREAKDOWN, {}).nodes, 'mcp')
  expect(mcp?.static).toBe(10_000)
  expect(mcp?.children.map(child => child.label)).toEqual(['linear'])
})

test('system is what the window holds beyond itemized static and Messages', () => {
  // 100k used - 40k Messages - (655 skills + 10k MCP + 5k memory + 300 agents)
  expect(node(buildTable(BREAKDOWN, {}).nodes, 'system')?.static).toBe(44_045)
})

test('conversation rows are named by source, without repeating a word', () => {
  const labels = node(buildTable(BREAKDOWN, tally([['prompt', 'prompt', 40], ['other', 'command', 40]])).nodes, 'conversation')
    ?.children.map(child => child.label)
  expect(labels?.sort()).toEqual(['other command', 'prompt'])
})
