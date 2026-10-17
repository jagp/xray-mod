import { expect, test } from 'claude-code/testing'

import { DEMO_PANE } from './register'
import { titleBar } from './viewport-model'

// T1 checks a-f, end to end through the engine's test kit: the demo pane's
// hooks (register.tsx), the viewport Client module (viewport.tsx), and the
// intents travelling between them. Each check names its PLAN letter.
//
// How the kit stands in for the engine: the test's own `on(...)` hooks sit at
// the bottom of every chain, so they observe what the plugin asked of the
// engine (a clipboard write, a toast, a pane scroll it passed on).

const KEY = 'demo' // the viewport's Client key (register.tsx DEMO_KEY)
const BODY_TOP = 3 //   first viewport body row in the pane tree (DEMO_BODY_TOP)

// The viewport's own drawing as one string, for substring checks.
const drawnText = async (ui: { drawn: (scope?: { in?: string }) => Promise<unknown> }) =>
  JSON.stringify(await ui.drawn({ in: KEY }))

// A pointer click on one title-bar control: titleBar() gives the column range
// the Client maps clicks against, so the test clicks exactly where it's drawn.
const controlColumn = (label: string, offset: number, collapsed: boolean) => {
  // The hook hands the Client its 12-line slice even while collapsed, so the
  // title still reads "1–12/500" then: compute the ranges from the same text.
  const bar = titleBar('demo.txt', offset, 12, 500, collapsed)
  const hit = bar.hits.find(one => bar.text.slice(one.from, one.to) === label)
  if (!hit) throw new Error(`no control ${label} in "${bar.text}"`)

  return hit.from
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`T1 viewport on ${surface}: scroll, keys, collapse, copy, expand`, async ($, on) => {
    // Hooks on operations (ui.copy, ui.toast) answer { value }; event hooks
    // (ui.scroll) answer the event's result directly.
    let copied = ''
    const toasts: string[] = []
    let paneScrolls = 0
    on('ui.copy', ($, e) => ((copied = e.text), { value: { isCopied: true as const } }))
    on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
    on('ui.scroll', () => ((paneScrolls += 1), {}))

    const ui = await $.ui.mount({
      plugin: 'xray-mod',
      surface,
      component: 'Pane',
      requestId: DEMO_PANE,
      props: { title: 'Viewport spike', isFocused: true, bodyColumns: 100 },
    })
    expect(await drawnText(ui)).toContain('1–12/500')

    // (a) a wheel tick over the viewport body scrolls the viewport, not the pane
    const tick = (row: number) =>
      $.ui.scroll({
        component: 'Pane', requestId: DEMO_PANE, offset: 0, by: 3, bodyRows: 20, contentRows: 46,
        origin: { kind: 'person' }, pointer: { column: 10, row },
      })
    await tick(BODY_TOP + 2)
    expect(await drawnText(ui)).toContain('4–15/500')
    expect(paneScrolls).toBe(0)

    // (b) a wheel tick elsewhere in the pane is passed on: the pane scrolls
    await tick(30)
    expect(paneScrolls).toBe(1)

    // (c) keys reach the focused viewport: a line, a page, and the ends
    await ui.key({ key: 'down', in: KEY })
    expect(await drawnText(ui)).toContain('5–16/500')
    await ui.key({ key: 'end', in: KEY })
    expect(await drawnText(ui)).toContain('489–500/500')
    await ui.key({ key: 'home', in: KEY })
    expect(await drawnText(ui)).toContain('1–12/500')

    // (d) [−] collapses to the title row; [+] restores it
    await ui.pointer({ type: 'down', x: controlColumn('[−]', 0, false), y: 0, button: 'left', in: KEY })
    expect(await drawnText(ui)).toContain('▸ demo.txt')
    expect(await drawnText(ui)).not.toContain('demo line 1:')
    await ui.pointer({ type: 'down', x: controlColumn('[+]', 0, true), y: 0, button: 'left', in: KEY })
    expect(await drawnText(ui)).toContain('demo line 1:')

    // (e) [copy] puts all 500 lines on the clipboard, not just the 12 drawn
    await ui.pointer({ type: 'down', x: controlColumn('[copy]', 0, false), y: 0, button: 'left', in: KEY })
    expect(copied.split('\n')).toHaveLength(500)
    expect(toasts.join(' ')).toContain('Copied 500 lines')

    // (f) [⤢] says pop-out comes in T7
    await ui.pointer({ type: 'down', x: controlColumn('[⤢]', 0, false), y: 0, button: 'left', in: KEY })
    expect(toasts.join(' ')).toContain('Pop-out arrives in T7')
  })
}
