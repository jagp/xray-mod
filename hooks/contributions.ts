// T3 · The contribution model: one table of what fills the context window,
// split into STATIC overhead (paid on every request) and ACTIVE contributions
// (what each source has added to the conversation).
//
// Two inputs, both already collected elsewhere:
//   - the engine's breakdown ($.session.usage({ breakdown })): the window by
//     category, plus per-item lists (skills, MCP tools, memory files, agents)
//     -> the STATIC column
//   - the attribution tally (attribution.ts via register.tsx#recordRow):
//     characters per source:item since the mod loaded -> the ACTIVE column
//
// The flow of buildTable():
//   1. read the window's used total and its Messages row
//   2. static: itemize skills / MCP servers / memory files / agents from the
//      breakdown's lists; whatever used, non-Messages tokens remain are the
//      system prompt and built-in tool schemas
//   3. active: convert tally chars to tokens, then reconcile against Messages
//      (reconcile(), below): scale DOWN if the estimates overshoot, never up
//   4. whatever Messages holds beyond the tally is its own honest row,
//      "Before xray-mod loaded", instead of being smeared over every item
//   5. group into nodes, largest first
// By construction static + active + unattributed = the used total, so the
// columns add up to what /context reports.
//
// Pure: no engine calls, so every rule is unit-tested (contributions.test.ts).

import type { Source, Tally } from '../types'

// The estimate T2 uses; T4 adds an exact mode and the on-screen badge.
export const CHARS_PER_TOKEN = 4

// The slice of SessionContextBreakdown this model reads (fixtures build it).
export type BreakdownInput = {
  categories: { name: string; kind: 'used' | 'free' | 'buffer' | 'deferred'; tokens: number }[]
  skills?: { skillFrontmatter: { name: string; tokens: number }[] }
  mcpTools: { serverName: string; tokens: number; isLoaded: boolean }[]
  memoryFiles: { path: string; tokens: number }[]
  agents: { agentType: string; tokens: number }[]
}

// The table's top-level rows. Order here is display order.
export type Group =
  | 'system'
  | 'skill'
  | 'mcp'
  | 'memory'
  | 'agent'
  | 'tool'
  | 'injection'
  | 'conversation'
  | 'unattributed'

export type Node = {
  key: string
  label: string
  static: number
  active: number
  calls: number
  isInferred: boolean // some of `active` was linked by arrival order (`~`)
  children: Node[]
}

export type Table = {
  nodes: Node[]
  total: number // the window's used tokens, which the columns sum to
  scale: number // 1, or < 1 when active estimates were scaled down to fit
}

const LABELS: Record<Group, string> = {
  system: 'System prompt & tools',
  skill: 'Skills',
  mcp: 'MCP servers',
  memory: 'Memory files',
  agent: 'Agents',
  tool: 'Built-in tools',
  injection: 'Engine injections',
  conversation: 'Conversation',
  unattributed: 'Before xray-mod loaded',
}

// Which table row a tally source lands in. The conversation row gathers the
// person's prompts, the model's own text, hook context and notices.
const GROUP_OF_SOURCE: Record<Source, Group> = {
  skill: 'skill',
  mcp: 'mcp',
  agent: 'agent',
  tool: 'tool',
  injection: 'injection',
  prompt: 'conversation',
  assistant: 'conversation',
  hook: 'conversation',
  other: 'conversation',
}

// Reconcile estimated active tokens against the real Messages row:
//   - estimates within Messages: keep them (scale 1); the rest is unattributed
//   - estimates above Messages: shrink every item by the same factor so they
//     fit exactly, leaving nothing unattributed
// Never scale up: a tally that started late must not be inflated to cover
// conversation it never saw.
export const reconcile = (knownTokens: number, messages: number): number =>
  knownTokens > messages && knownTokens > 0 ? messages / knownTokens : 1

const emptyNode = (key: string, label: string): Node => ({
  key,
  label,
  static: 0,
  active: 0,
  calls: 0,
  isInferred: false,
  children: [],
})

// Find the child with this label, creating it on first use, so static and
// active amounts for the same skill (or server, or agent) share one row.
const childOf = (parent: Node, label: string): Node => {
  let child = parent.children.find(one => one.label === label)
  if (!child) {
    child = emptyNode(`${parent.key}/${label}`, label)
    parent.children.push(child)
  }

  return child
}

// A group's own numbers are the sum of its children, largest child first.
const rollUp = (node: Node): Node => {
  if (node.children.length === 0) return node
  node.children.sort((a, b) => b.static + b.active - (a.static + a.active))
  node.static = node.children.reduce((sum, child) => sum + child.static, 0)
  node.active = node.children.reduce((sum, child) => sum + child.active, 0)
  node.calls = node.children.reduce((sum, child) => sum + child.calls, 0)
  node.isInferred = node.children.some(child => child.isInferred)

  return node
}

export const buildTable = (breakdown: BreakdownInput, tally: Readonly<Record<string, Tally>>): Table => {
  // 1. The window: used tokens in all, and the Messages row within them.
  //    Rows carry no kind for "messages", so this one row is found by name.
  const used = breakdown.categories.filter(row => row.kind === 'used')
  const total = used.reduce((sum, row) => sum + row.tokens, 0)
  const messages = used.find(row => /^messages$/i.test(row.name))?.tokens ?? 0

  const groups = new Map<Group, Node>()
  const group = (name: Group) => {
    let node = groups.get(name)
    if (!node) {
      node = emptyNode(name, LABELS[name])
      groups.set(name, node)
    }

    return node
  }

  // 2. Static, itemized from the breakdown's own lists.
  for (const skill of breakdown.skills?.skillFrontmatter ?? []) {
    childOf(group('skill'), skill.name).static += skill.tokens
  }
  for (const tool of breakdown.mcpTools) {
    if (tool.isLoaded) childOf(group('mcp'), tool.serverName).static += tool.tokens // deferred schemas sit outside the window
  }
  for (const file of breakdown.memoryFiles) childOf(group('memory'), file.path).static += file.tokens
  for (const agent of breakdown.agents) childOf(group('agent'), agent.agentType).static += agent.tokens
  for (const node of groups.values()) rollUp(node)

  const itemized = [...groups.values()].reduce((sum, node) => sum + node.static, 0)
  group('system').static = Math.max(0, total - messages - itemized) // system prompt + built-in tool schemas

  // 3. Active, from the tally, reconciled against Messages.
  const entries = Object.values(tally)
  const knownTokens = entries.reduce((sum, entry) => sum + entry.chars / CHARS_PER_TOKEN, 0)
  const scale = reconcile(knownTokens, messages)
  let attributed = 0
  for (const entry of entries) {
    const tokens = Math.round((entry.chars / CHARS_PER_TOKEN) * scale)
    const target = GROUP_OF_SOURCE[entry.source]
    // Conversation rows name their source too ("assistant text", "other command"),
    // except where the two are the same word ("prompt", not "prompt prompt").
    const label =
      target !== 'conversation' ? entry.item
      : entry.item === entry.source ? entry.source
      : `${entry.source} ${entry.item}`
    const child = childOf(group(target), label)
    child.active += tokens
    child.calls += entry.calls
    child.isInferred = child.isInferred || entry.isInferred
    attributed += tokens
  }

  // 4. What Messages holds beyond the tally: its own row, never smeared.
  const unattributed = Math.max(0, messages - attributed)
  if (unattributed > 0) group('unattributed').active = unattributed

  // 5. Roll groups up and order them as LABELS lists them.
  const order = Object.keys(LABELS) as Group[]
  const nodes = order.flatMap(name => {
    const node = groups.get(name)
    return node ? [rollUp(node)] : []
  })

  return { nodes, total, scale }
}
