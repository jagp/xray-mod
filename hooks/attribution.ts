// Attribution: which source put each piece of text into the context window.
//
// Fed one transcript row at a time from the `session.append` hook
// (register.tsx), so the ledger grows incrementally and never re-walks the
// transcript. Pure: no engine calls, so every rule below is unit-tested
// (attribution.test.ts) against row shapes seen in a real transcript.
//
// The flow for one row:
//   1. toRow()    flatten the engine's event into a plain Row (sizes, ids)
//   2. classify() turn the Row into Contributions, using the Ledger to link
//                 a tool's result (and anything it hands over) to its call
//   3. the caller stores the new Ledger (it is plain JSON, kept in $.state)

import type { Ledger, Source } from '../types'

export type { Ledger, Source }

// --- Shapes -----------------------------------------------------------------
// Source and Ledger live in the state contract (types/index.d.ts), since the
// ledger is stored in $.state.

export type Contribution = {
  source: Source
  item: string // the row in the table: a tool, skill, server, attachment kind
  callId?: string // the tool call it belongs to, when there is one
  chars: number
  isInferred?: true // linked by arrival order rather than an explicit id
  agentId?: string // set when the row is in a subagent's own window
}

// One transcript row, flattened from SessionAppendInput by toRow().
export type Row = {
  door: string
  originKind: string
  originTool?: string
  type: string
  name?: string // an attachment's kind
  isMeta?: boolean
  agentId?: string
  blocks: Block[]
}

export type Block =
  | { kind: 'text'; chars: number }
  | { kind: 'tool_use'; id: string; tool: string; input: Record<string, unknown>; chars: number }
  | { kind: 'tool_result'; toolUseId: string; chars: number }

export const EMPTY_LEDGER: Ledger = { calls: {} }

// --- Naming -----------------------------------------------------------------

// Names a call by what it touched: which skill, which search, which file.
// Also the shift log's cause label (register.tsx).
export const describe = (tool: string, input: Readonly<Record<string, unknown>>): string => {
  const arg =
    tool === 'Skill' ? input.skill
    : tool === 'ToolSearch' ? input.query
    : tool === 'Agent' ? input.subagent_type
    : tool === 'Read' ? String(input.file_path ?? '').split(/[\\/]/).pop()
    : undefined

  return typeof arg === 'string' && arg !== '' ? `${tool}(${arg})` : tool
}

// Which category a tool's traffic belongs to, and the row it lands on:
//   - Skill  -> skill, one row per skill name
//   - Agent  -> agent, one row per subagent type
//   - mcp__<server>__<tool> -> mcp, one row per server
//   - anything else -> tool, one row per tool name
export const sourceFor = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
): { source: Source; item: string } => {
  if (tool === 'Skill') return { source: 'skill', item: String(input.skill ?? 'unknown') }
  if (tool === 'Agent') return { source: 'agent', item: String(input.subagent_type ?? 'general-purpose') }
  const mcp = /^mcp__(.+?)__/.exec(tool)
  if (mcp) return { source: 'mcp', item: mcp[1] ?? tool }

  return { source: 'tool', item: tool }
}

// --- Flattening -------------------------------------------------------------

type ContentBlock = { type: string; [key: string]: unknown }

// Character count of a tool_result's content, which is a string or blocks.
const resultChars = (content: unknown): number =>
  typeof content === 'string' ? content.length
  : Array.isArray(content) ? content.reduce((sum: number, block: { text?: unknown }) => sum + String(block.text ?? '').length, 0)
  : 0

// Flatten a session.append event into a Row:
//   - keep the door, the origin's kind and tool, the attachment name, isMeta
//   - reduce each content block to its size (and ids, for tool traffic)
//   - text and thinking both count as text; images and others are skipped
export const toRow = (event: {
  door: string
  origin: { kind: string; tool?: string }
  agentId?: string
  message: { type: string; name?: string; isMeta?: true; content: readonly ContentBlock[] }
}): Row => ({
  door: event.door,
  originKind: event.origin.kind,
  originTool: event.origin.tool,
  type: event.message.type,
  name: event.message.name,
  isMeta: event.message.isMeta === true,
  agentId: event.agentId,
  blocks: event.message.content.flatMap((block): Block[] => {
    if (block.type === 'text') return [{ kind: 'text', chars: String(block.text ?? '').length }]
    if (block.type === 'thinking') return [{ kind: 'text', chars: String(block.thinking ?? '').length }]
    if (block.type === 'tool_use') {
      const input = (block.input ?? {}) as Record<string, unknown>
      return [{ kind: 'tool_use', id: String(block.id), tool: String(block.name), input, chars: JSON.stringify(input).length }]
    }
    if (block.type === 'tool_result') {
      return [{ kind: 'tool_result', toolUseId: String(block.tool_use_id), chars: resultChars(block.content) }]
    }

    return []
  }),
})

// --- Classification ---------------------------------------------------------

// Doors with no tool traffic map straight to a source.
const SOURCE_BY_DOOR: Record<string, Source> = {
  prompt: 'prompt',
  attachment: 'injection',
  'hook-context': 'hook',
}

const textChars = (row: Row): number =>
  row.blocks.reduce((sum, block) => sum + (block.kind === 'text' ? block.chars : 0), 0)

// Turn one Row into Contributions, returning the updated Ledger too.
//
//   1. Tool calls (assistant rows): each tool_use is registered in the ledger
//      under its id, and its input counts toward that call's item.
//   2. Tool results: looked up by tool_use_id, so a result always lands on
//      the call that asked for it; it becomes the ledger's lastResultId.
//   3. Rows a tool hands over beside its result (origin kind `tool`, e.g. a
//      skill's body, which arrives isMeta right after "Launching skill"):
//      no id links them, so they join the last result's call when the tool
//      names match. That link is by arrival order: marked isInferred.
//   4. Everything else is text by door: prompt, attachment (by its kind),
//      hook context, the model's own text, or `other`.
export const classify = (row: Row, ledger: Ledger): { contributions: Contribution[]; ledger: Ledger } => {
  const contributions: Contribution[] = []
  const calls = { ...ledger.calls }
  let lastResultId = ledger.lastResultId
  const add = (contribution: Contribution) =>
    contributions.push(row.agentId ? { ...contribution, agentId: row.agentId } : contribution)

  for (const block of row.blocks) {
    if (block.kind === 'tool_use') { //                            step 1
      const { source, item } = sourceFor(block.tool, block.input)
      calls[block.id] = { source, item, tool: block.tool }
      add({ source, item, callId: block.id, chars: block.chars })
    } else if (block.kind === 'tool_result') { //                  step 2
      const call = calls[block.toolUseId]
      add(
        call
          ? { source: call.source, item: call.item, callId: block.toolUseId, chars: block.chars }
          : { source: 'tool', item: 'unknown', callId: block.toolUseId, chars: block.chars },
      )
      lastResultId = block.toolUseId
    }
  }

  const chars = textChars(row)
  if (chars > 0) {
    const last = lastResultId ? calls[lastResultId] : undefined
    if (row.originKind === 'tool' && last && last.tool === row.originTool) { // step 3
      add({ source: last.source, item: last.item, callId: lastResultId, chars, isInferred: true })
    } else if (row.door === 'response') { //                                  step 4
      add({ source: 'assistant', item: 'text', chars })
    } else {
      const source = SOURCE_BY_DOOR[row.door] ?? 'other'
      const item = source === 'injection' ? (row.name ?? 'attachment') : row.door
      add({ source, item, chars })
    }
  }

  return { contributions, ledger: { calls, lastResultId } }
}
