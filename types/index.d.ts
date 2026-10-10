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

declare module 'claude-code' {
  interface PluginState {
    'context-lens': { snapshot: Snapshot | null; log: Shift[] }
  }
}
