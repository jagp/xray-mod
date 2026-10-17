import { expect, test } from 'claude-code/testing'

// T2 check, end to end through the engine's test kit: transcript rows raised
// as a session raises them pass through the plugin's session.append hook
// (register.tsx), get classified (attribution.ts), and show up in the
// /xray-mod-attribution readout.
//
// The rows replay what a real transcript holds around a Skill call:
//   1. the model's tool_use for Skill
//   2. the tool_result "Launching skill: ..."
//   3. the skill's body: an isMeta user row the Skill tool hands over
//   4. an engine attachment (a hidden injection)

const BODY_CHARS = 9292 // the plugin-authoring body's size in the real transcript

test('T2 attribution: a skill call, its body and an injection reach the readout', async ($, on) => {
  let uuid = 0
  const append = (fields: Record<string, unknown>) =>
    $.session.append({ uuid: `row-${(uuid += 1)}`, ...fields } as Parameters<typeof $.session.append>[0])

  await append({
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    message: { type: 'assistant', role: 'assistant', content: [
      { type: 'tool_use', id: 'skill-1', name: 'Skill', input: { skill: 'plugin-authoring' } },
    ] },
  })
  await append({
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Skill' },
    message: { type: 'user', role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'skill-1', content: 'Launching skill: plugin-authoring' },
    ] },
  })
  await append({
    door: 'tool-message',
    origin: { kind: 'tool', tool: 'Skill' },
    message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: 'x'.repeat(BODY_CHARS) }] },
  })
  await append({
    door: 'attachment',
    origin: { kind: 'engine' },
    message: { type: 'attachment', name: 'deferred_tools_delta', content: [{ type: 'text', text: 'y'.repeat(400) }] },
  })

  const reply = await $.command.run({
    command: 'xray-mod-attribution',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  const text = String((reply as { text?: string }).text ?? '')

  // The skill row: one call, the body's ~2.3k tokens counted, linked by order (~)
  const skillRow = text.split('\n').find(line => line.includes('plugin-authoring')) ?? ''
  expect(skillRow).toContain('skill')
  expect(skillRow).toContain('×1')
  expect(skillRow).toContain('~')
  expect(skillRow).toMatch(/2\.\dk/)
  // The hidden injection, by its attachment kind
  expect(text).toMatch(/injection\s+deferred_tools_delta/)
})
