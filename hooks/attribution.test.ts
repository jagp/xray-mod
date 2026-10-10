import { expect, test } from 'claude-code/testing'

import { classify, EMPTY_LEDGER, toRow } from './attribution'
import type { Contribution, Ledger } from './attribution'

// Event builders shaped like session.append's input, one per kind of row seen
// in a real transcript around a Skill call (see docs/PLAN.md, T2).
const call = (id: string, name: string, input: Record<string, unknown>) => ({
  door: 'response',
  origin: { kind: 'model' },
  message: { type: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
})
const result = (id: string, tool: string, text: string) => ({
  door: 'tool-result',
  origin: { kind: 'tool', tool },
  message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
})
const handedOver = (tool: string, text: string) => ({
  door: 'tool-message',
  origin: { kind: 'tool', tool },
  message: { type: 'user', isMeta: true as const, content: [{ type: 'text', text }] },
})
const attachment = (name: string, text: string) => ({
  door: 'attachment',
  origin: { kind: 'engine' },
  message: { type: 'attachment', name, content: [{ type: 'text', text }] },
})

// Run a sequence of events through classify, collecting every contribution.
const run = (events: Parameters<typeof toRow>[0][]): Contribution[] => {
  let ledger: Ledger = EMPTY_LEDGER
  const all: Contribution[] = []
  for (const event of events) {
    const out = classify(toRow(event), ledger)
    ledger = out.ledger
    all.push(...out.contributions)
  }

  return all
}

test('a skill body joins the Skill call it follows, marked inferred', () => {
  const rows = run([
    call('s1', 'Skill', { skill: 'plugin-authoring' }),
    result('s1', 'Skill', 'Launching skill: plugin-authoring'),
    handedOver('Skill', 'x'.repeat(9292)), // the body: 9292 chars in the real transcript
    attachment('deferred_tools_delta', 'y'.repeat(40)),
  ])
  const body = rows.find(row => row.chars === 9292)
  expect(body).toEqual({ source: 'skill', item: 'plugin-authoring', callId: 's1', chars: 9292, isInferred: true })
  expect(rows.at(-1)).toEqual({ source: 'injection', item: 'deferred_tools_delta', chars: 40 })
})

test('a result lands on its own call even when calls interleave', () => {
  const rows = run([
    call('a', 'Read', { file_path: 'C:\\x\\a.md' }),
    call('b', 'mcp__linear__create_issue', {}),
    result('b', 'mcp__linear__create_issue', 'ok'),
    result('a', 'Read', 'zzzz'),
  ])
  expect(rows.filter(row => row.callId === 'a').map(row => row.item)).toEqual(['Read', 'Read'])
  expect(rows.find(row => row.callId === 'b' && row.chars === 2)?.source).toBe('mcp')
  expect(rows.find(row => row.callId === 'b')?.item).toBe('linear')
})

test('handed-over text from a different tool is not misattributed', () => {
  const rows = run([
    call('s1', 'Skill', { skill: 'docs' }),
    result('s1', 'Skill', 'Launching skill: docs'),
    handedOver('Bash', 'stray'),
  ])
  expect(rows.at(-1)).toEqual({ source: 'other', item: 'tool-message', chars: 5 })
})

test('prompts, model text and subagent rows are tagged', () => {
  const rows = run([
    { door: 'prompt', origin: { kind: 'person' }, message: { type: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { door: 'response', origin: { kind: 'model' }, message: { type: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } },
    { ...attachment('nested_memory', 'mem'), agentId: 'agent-7' },
  ])
  expect(rows).toEqual([
    { source: 'prompt', item: 'prompt', chars: 2 },
    { source: 'assistant', item: 'text', chars: 3 },
    { source: 'injection', item: 'nested_memory', chars: 3, agentId: 'agent-7' },
  ])
})
