import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Row, Shift, Snapshot } from '../types'

const PANE = 'context-lens'
const TITLE = 'Context'
const LOG_SIZE = 12
// Ignore estimate jitter below this many tokens when logging a shift.
const NOISE = 100

const snapshot = atom({ plugin: 'context-lens', key: 'snapshot' } as const, null)
const log = atom({ plugin: 'context-lens', key: 'log' } as const, [])

export const fmt = (n: number): string =>
  Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

const signed = (n: number): string => (n > 0 ? `+${fmt(n)}` : `-${fmt(-n)}`)

// Names the call in the shift log: which skill, which search, which file.
export const describe = (tool: string, input: Readonly<Record<string, unknown>>): string => {
  const arg =
    tool === 'Skill' ? input.skill
    : tool === 'ToolSearch' ? input.query
    : tool === 'Agent' ? input.subagent_type
    : tool === 'Read' ? String(input.file_path ?? '').split(/[\\/]/).pop()
    : undefined

  return typeof arg === 'string' && arg !== '' ? `${tool}(${arg})` : tool
}

export const diffRows = (
  rows: Omit<Row, 'delta'>[],
  previous: Snapshot | null,
): Row[] =>
  rows.map(row => {
    const before = previous?.rows.find(one => one.name === row.name)

    return { ...row, delta: before ? row.tokens - before.tokens : 0 }
  })

export const summarize = (rows: Row[]): string =>
  rows
    .filter(row => (row.kind === 'used' || row.kind === 'deferred') && Math.abs(row.delta) >= NOISE)
    .map(row => `${row.name} ${signed(row.delta)}`)
    .join(', ')

const pushShift = ($: EngineInterface, shift: Shift) =>
  update($, log, list => [...list, shift].slice(-LOG_SIZE))

const measure = async (
  $: EngineInterface,
  detail: 'summary' | 'full',
  cause: string,
  isForced = false,
) => {
  const usage = await $.session.usage({ breakdown: detail })
  const b = usage.context.breakdown
  if (!b) return

  const previous = await read($, snapshot)
  const rows = diffRows(
    b.categories.map(c => ({ name: c.name, kind: c.kind, color: c.color, tokens: c.tokens })),
    previous,
  )

  const servers = new Map<string, { loaded: number; deferred: number; tokens: number }>()
  for (const tool of b.mcpTools) {
    const s = servers.get(tool.serverName) ?? { loaded: 0, deferred: 0, tokens: 0 }
    if (tool.isLoaded) s.loaded += 1
    else s.deferred += 1
    s.tokens += tool.tokens
    servers.set(tool.serverName, s)
  }

  const at = await $.clock.now()
  const next: Snapshot = {
    at,
    detail,
    model: b.model,
    total: b.totalTokens,
    max: b.rawMaxTokens,
    percent: b.percentage,
    autoCompactAt: b.autoCompactThreshold,
    rows,
    memory: [...b.memoryFiles].sort((x, y) => y.tokens - x.tokens),
    mcp: [...servers].map(([server, s]) => ({ server, ...s })).sort((x, y) => y.tokens - x.tokens),
    skills: b.skills && {
      included: b.skills.includedSkills,
      total: b.skills.totalSkills,
      tokens: b.skills.tokens,
      top: [...b.skills.skillFrontmatter]
        .sort((x, y) => y.tokens - x.tokens)
        .slice(0, 5)
        .map(s => ({ name: s.name, tokens: s.tokens })),
    },
    agents: b.agents.map(a => ({ name: a.agentType, tokens: a.tokens })),
  }
  await update($, snapshot, () => next)

  const changes = summarize(rows)
  if (changes !== '' || isForced) {
    await pushShift($, { at, cause, changes: changes || 'no change' })
  }
}

// Measurements run one at a time, in order, so each diff is against the last.
let queue: Promise<void> = Promise.resolve()
// Main-thread tool calls since the last measurement, named for the shift log.
const causes: string[] = []

const enqueue = (
  $: EngineInterface,
  detail: 'summary' | 'full',
  cause: string,
  isForced = false,
) => {
  queue = queue.then(() => measure($, detail, cause, isForced)).catch(() => {})
}

const openPane = async ($: EngineInterface) => {
  await $.ui.open({ id: PANE, title: TITLE })
  enqueue($, 'full', 'opened')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context-lens',
      description: 'Open the live context breakdown pane (runs an exact count)',
    })

    return next(e)
  })

  on('command.run', { command: 'context-lens' }, async $ => {
    await openPane($)

    return { text: 'Context pane opened; exact count running.' }
  })

  // Note which main-thread tools ran; the next model step measures what they
  // added. A skill's body or a searched tool's schema enters the window after
  // the tool result, so measuring at the result would miss it.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!e.agentId) {
      // A tool's arguments sit on the event itself (e.skill, e.query, ...).
      causes.push(describe(e.tool, e as unknown as Record<string, unknown>))
    }

    return ran
  }).catch(($, e, next) => next(e)) // an observer never blocks a tool

  // turn.step streams, so its hook is an async generator forwarding the chunks.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      // Subagents run in windows of their own: log their steps, don't measure them.
      await pushShift($, {
        at: await $.clock.now(),
        cause: `subagent step ${e.index}`,
        changes: `${e.messageCount} msgs, own window`,
        agentId: e.agentId,
      })
    } else if (e.index > 0) {
      // Main thread, mid-turn: everything since the last request is in the window now.
      const cause = causes.splice(0).join(', ') || 'between requests'
      enqueue($, 'summary', cause)
    }

    return yield* next(e)
  })

  // After each main turn, when the context fill moved: the exact count.
  // Rate-limit and cost ticks fire this too; a full count there would be waste.
  on('session.measure', ($, e, next) => {
    if (e.changed.includes('context')) {
      enqueue($, 'full', causes.splice(0).join(', ') || 'turn end')
    }

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) enqueue($, 'summary', `compaction (${e.trigger})`, true)

    return done
  }).catch(($, e, next) => next(e))

  // The opener: a live percentage pill beside the footer's mode labels.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const own = await next(e)
    const label = snap ? `◧ ${snap.percent}%` : '◧ context'

    return (
      <Box>
        {own}
        <Button key="context-lens" label={label} onPress={() => openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const shifts = await read($, log)

    if (!snap) return <Text dimColor>Measuring…</Text>

    const used = snap.rows.filter(row => row.kind !== 'deferred')
    const deferred = snap.rows.filter(row => row.kind === 'deferred')

    return (
      <Box flexDirection="column">
        <Text bold>
          {fmt(snap.total)} / {fmt(snap.max)} ({snap.percent}%) · {snap.model}
        </Text>
        <Text dimColor>
          {snap.detail === 'full' ? 'exact count' : 'estimate'}
          {snap.autoCompactAt ? ` · autocompact at ${fmt(snap.autoCompactAt)}` : ' · autocompact off'}
        </Text>

        <Text> </Text>
        {used.map(row => (
          <Text key={row.name}>
            <Text color={row.color}>■ </Text>
            {row.name.padEnd(22)} {fmt(row.tokens).padStart(7)}{' '}
            {Math.abs(row.delta) >= NOISE && <Text color={row.delta > 0 ? 'warning' : 'success'}>{signed(row.delta)}</Text>}
          </Text>
        ))}
        {deferred.map(row => (
          <Text key={row.name} dimColor>
            □ {row.name.padEnd(22)} {fmt(row.tokens).padStart(7)} (outside window)
          </Text>
        ))}

        {snap.memory.length > 0 && <Text bold>{'\n'}Memory files</Text>}
        {snap.memory.slice(0, 6).map(m => (
          <Text key={m.path} dimColor>
            {fmt(m.tokens).padStart(6)} {m.type.padEnd(8)} {m.path}
          </Text>
        ))}

        {snap.skills && (
          <Text bold>
            {'\n'}Skills {snap.skills.included}/{snap.skills.total} listed · {fmt(snap.skills.tokens)}
          </Text>
        )}
        {snap.skills?.top.map(s => (
          <Text key={s.name} dimColor>
            {fmt(s.tokens).padStart(6)} {s.name}
          </Text>
        ))}

        {snap.mcp.length > 0 && <Text bold>{'\n'}MCP servers</Text>}
        {snap.mcp.slice(0, 6).map(s => (
          <Text key={s.server} dimColor>
            {fmt(s.tokens).padStart(6)} {s.server} ({s.loaded} loaded, {s.deferred} deferred)
          </Text>
        ))}

        <Text bold>{'\n'}Shifts</Text>
        {shifts.length === 0 && <Text dimColor>None yet.</Text>}
        {[...shifts].reverse().map((s, i) => (
          <Text key={`${s.at}-${i}`} dimColor={!!s.agentId}>
            {new Date(s.at).toTimeString().slice(0, 5)} {s.cause} → {s.changes}
          </Text>
        ))}
      </Box>
    )
  })
}
