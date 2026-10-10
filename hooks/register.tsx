import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Row, Shift, Snapshot } from '../types'
import { apply, INITIAL, isOverViewport } from './viewport-model'
import type { Intent, ViewportProps } from './viewport-model'

export const PANE = 'xray-mod'
const TITLE = 'Context'
const LOG_SIZE = 12
// Ignore estimate jitter below this many tokens when logging a shift.
const NOISE = 100

const snapshot = atom({ plugin: 'xray-mod', key: 'snapshot' } as const, null)
const log = atom({ plugin: 'xray-mod', key: 'log' } as const, [])
// Each viewport's scroll offset and collapsed flag, keyed by its Client key.
const viewports = atom({ plugin: 'xray-mod', key: 'viewports' } as const, {})

// --- T1 viewport spike: a demo pane holding one viewport over 500 lines -----
// The demo pane's tree, top to bottom (row numbers matter for the wheel math):
//   row 0      hint text
//   row 1      blank
//   row 2      viewport title row
//   rows 3..   viewport body (DEMO_HEIGHT rows)
//   then       filler rows, so the pane itself has something to scroll
// Pane ids allow only letters, digits, `_` and `-` (PaneOpenArgs.id); any
// other character makes $.ui.open reject and the hook calling it fail.
export const DEMO_PANE = 'xray-mod-viewport-demo'
const DEMO_KEY = 'demo'
const DEMO_BODY_TOP = 3
const DEMO_HEIGHT = 12
const DEMO_LINES = Array.from(
  { length: 500 },
  (_, index) => `demo line ${index + 1}: ${'·'.repeat(index % 40)}|`,
)
// The pane's own scroll offset as last passed through ui.scroll; the wheel
// pointer's row is relative to what the pane shows, so we need it to find the
// row in the pane's full tree (viewport-model.ts#isOverViewport).
let demoPaneOffset = 0

// Fold one Intent into the demo viewport's stored state; the atom write
// redraws the pane, which hands the Client its new slice.
const applyToDemo = (
  $: EngineInterface,
  intent: Intent,
) =>
  update($, viewports, all => ({
    ...all,
    [DEMO_KEY]: apply(all[DEMO_KEY] ?? INITIAL, intent, DEMO_LINES.length, DEMO_HEIGHT),
  }))

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

// What both /xray-mod and /xrm do: open the pane (which starts an exact count).
const openCommand = async ($: EngineInterface) => {
  await openPane($)

  return { text: 'xray-mod opened; exact count running.' }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'xray-mod',
      description: 'Open the context x-ray: every token, traced to its source',
    })
    await $.command.register({ name: 'xrm', description: 'Same as /xray-mod' })
    await $.command.register({
      name: 'xray-mod-viewport-demo',
      description: 'T1 spike: open a pane with one scrollable viewport over 500 lines',
    })

    return next(e)
  })

  on('command.run', { command: 'xray-mod-viewport-demo' }, async $ => {
    await $.ui.open({ id: DEMO_PANE, title: 'Viewport spike' })

    return { text: 'Viewport spike opened: wheel over it, click it then use arrows, try [copy].' }
  })

  // Draw the demo pane: hint, the viewport (a Client), then filler.
  //   1. read this viewport's state (offset, collapsed)
  //   2. hand the Client only the visible slice of DEMO_LINES
  //   3. size the Client: title row + body, or the title row alone when collapsed
  on('ui.render', { component: 'Pane', requestId: DEMO_PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const state = (await read($, viewports))[DEMO_KEY] ?? INITIAL
    const props: ViewportProps = {
      title: 'demo.txt',
      lines: DEMO_LINES.slice(state.offset, state.offset + DEMO_HEIGHT),
      startLine: state.offset,
      total: DEMO_LINES.length,
      height: DEMO_HEIGHT,
      collapsed: state.collapsed,
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>Wheel over the viewport scrolls it; elsewhere scrolls the pane.</Text>
        <Text> </Text>
        {'Client' in elements ? (
          <elements.Client
            key={DEMO_KEY}
            module="./viewport.tsx"
            props={props}
            height={state.collapsed ? 1 : DEMO_HEIGHT + 1}
          />
        ) : (
          // Mobile draws no Client: show the same slice as plain text.
          props.lines.map((line, index) => <Text key={`line-${index}`}>{line}</Text>)
        )}
        {Array.from({ length: 30 }, (_, index) => (
          <Text key={`filler-${index}`} dimColor>
            pane filler {index + 1}
          </Text>
        ))}
      </Box>
    )
  })

  // The viewport posted an Intent (viewport.tsx). Act on it:
  //   - copy:   the FULL text (not just the slice) goes to the clipboard
  //   - expand: pop-out lands in T7; say so instead of doing nothing
  //   - scroll / toggle: fold into the atom, which redraws the pane
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== DEMO_PANE || e.element !== DEMO_KEY) return next(e)
    const intent = e.data as Intent

    if (intent.type === 'copy') {
      const copied = await $.ui.copy({ text: DEMO_LINES.join('\n'), surface: e.surface })
      $.ui.toast(copied.isCopied ? `Copied ${DEMO_LINES.length} lines` : `Copy failed: ${copied.reason}`)
    } else if (intent.type === 'expand') {
      $.ui.toast('Pop-out arrives in T7')
    } else {
      await applyToDemo($, intent)
    }

    return {}
  })

  // The wheel reaches the pane, never the Client. A person's tick whose
  // pointer is over the viewport body scrolls the viewport and the pane stays
  // put (returning without next() leaves the pane where it is); any other
  // scroll moves the pane as usual, and we remember where it went.
  on('ui.scroll', { component: 'Pane', requestId: DEMO_PANE }, async ($, e, next) => {
    const state = (await read($, viewports))[DEMO_KEY] ?? INITIAL
    const isOnViewport =
      e.origin.kind === 'person' &&
      e.pointer !== undefined &&
      !state.collapsed &&
      isOverViewport(demoPaneOffset, e.pointer.row, DEMO_BODY_TOP, DEMO_HEIGHT)

    if (isOnViewport) {
      await applyToDemo($, { type: 'scroll', by: e.by })

      return {}
    }
    demoPaneOffset = e.offset

    return next(e)
  })

  // /xray-mod and its short alias /xrm share one handler (openCommand, above).
  on('command.run', { command: 'xray-mod' }, openCommand)
  on('command.run', { command: 'xrm' }, openCommand)

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
        <Button key="xray-mod" label={label} onPress={() => openPane($)} />
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
