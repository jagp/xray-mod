export type Row = {
  name: string
  kind: 'used' | 'free' | 'buffer' | 'deferred'
  color: string
  tokens: number
  delta: number
}

export type Snapshot = {
  at: number
  detail: 'summary' | 'full'
  model: string
  total: number
  max: number
  percent: number
  autoCompactAt?: number
  rows: Row[]
  memory: { path: string; type: string; tokens: number }[]
  mcp: { server: string; loaded: number; deferred: number; tokens: number }[]
  skills?: { included: number; total: number; tokens: number; top: { name: string; tokens: number }[] }
  agents: { name: string; tokens: number }[]
}

export type Shift = {
  at: number
  cause: string
  changes: string
  agentId?: string
}

// The state contract must be self-contained (no imports), so the attribution
// types stored in $.state are declared here and hooks/attribution.ts imports
// them from this file.

// Where a contribution came from; the table's top-level categories (T3).
export type Source =
  | 'prompt' //    what the person typed
  | 'assistant' // the model's own text and thinking
  | 'tool' //      a built-in tool's call input and result
  | 'skill' //     a Skill call, its result, and the skill body it loads
  | 'agent' //     an Agent call and the subagent's report
  | 'mcp' //       an MCP tool's call and result, grouped by server
  | 'injection' // an engine attachment: memory, reminders, tool deltas, ...
  | 'hook' //      context a settings hook added
  | 'other' //     notices, commands, deliveries, compaction rows

// What attribution.ts#classify remembers between rows: each call's identity,
// and the call whose result landed most recently.
export type Ledger = {
  calls: Record<string, { source: Source; item: string; tool: string }>
  lastResultId?: string
}

// One source:item's running total of what it put into the window.
export type Tally = { source: Source; item: string; chars: number; calls: number; isInferred: boolean }

export type ViewportState = { offset: number; collapsed: boolean }

declare module 'claude-code' {
  interface PluginState {
    'xray-mod': {
      snapshot: Snapshot | null
      log: Shift[]
      attribution: { ledger: Ledger; tally: Record<string, Tally> }
      viewports: Record<string, ViewportState>
    }
  }
}
