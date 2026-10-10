// Pure viewport logic, shared by the hooks module (register.tsx) and the
// Client module (viewport.tsx). No engine calls here, so it is unit-testable.
//
// Who owns what:
//   - The HOOKS own each viewport's ViewportState (scroll offset, collapsed),
//     kept in the `viewports` atom (types/index.d.ts).
//   - The CLIENT only draws the slice of lines it is handed, and posts Intents
//     (scroll / copy / toggle / expand) back to the hooks.
//   - The mouse wheel never reaches a Client: it arrives at the pane as a
//     `ui.scroll` event, which the hooks redirect here via isOverViewport().

export type ViewportState = { offset: number; collapsed: boolean }

// What the Client asks the hooks to do.
export type Intent =
  | { type: 'scroll'; by: number } // move the window by N lines (negative = up)
  | { type: 'copy' } //               put the FULL text on the clipboard
  | { type: 'toggle' } //             collapse <-> expand in place
  | { type: 'expand' } //             pop out into a pane of its own (T7)

// What the hooks hand the Client on each draw: only the visible slice,
// which keeps props far below the 100k-character Client props cap.
export type ViewportProps = {
  title: string
  lines: string[] //   the visible slice only
  startLine: number // 0-based index of lines[0] in the full text
  total: number //     line count of the full text
  height: number //    body rows the viewport shows when expanded
  collapsed: boolean
}

export const INITIAL: ViewportState = { offset: 0, collapsed: false }

// Keep the window inside the text:
//   - never above line 0
//   - never so low that the last page is short (offset <= total - height)
//   - a text shorter than the window always sits at offset 0
export const clampOffset = (offset: number, total: number, height: number): number =>
  Math.max(0, Math.min(offset, Math.max(0, total - height)))

// Apply one Intent to a viewport's state, returning the new state:
//   - scroll: shift the offset, then clamp it to the text
//   - toggle: flip collapsed
//   - copy / expand: no state change (the hooks act on them directly)
export const apply = (
  state: ViewportState,
  intent: Intent,
  total: number,
  height: number,
): ViewportState => {
  if (intent.type === 'scroll') {
    return { ...state, offset: clampOffset(state.offset + intent.by, total, height) }
  }
  if (intent.type === 'toggle') return { ...state, collapsed: !state.collapsed }

  return state
}

// Translate a key the focused Client received into a scroll Intent:
//   - up/down move one line, pageup/pagedown one window
//   - home/end move by the whole length; clampOffset lands them on the edges
//   - any other key is not ours (null)
// Key names are the engine's (`up`, `pageup`, ...): ClientKeyEvent.key.
export const keyToIntent = (key: string, height: number, total: number): Intent | null => {
  const distanceByKey: Record<string, number> = {
    up: -1,
    down: 1,
    pageup: -height,
    pagedown: height,
    home: -total,
    end: total,
  }

  return key in distanceByKey ? { type: 'scroll', by: distanceByKey[key] ?? 0 } : null
}

type Hit = { from: number; to: number; intent: Intent }

// Build the title row's text AND the column range of each clickable control,
// so the Client can map a pointer click's x to the control under it:
//   1. arrow + title + "first–last/total" line range
//   2. append each control label, recording [from, to) columns as we go
// Example: "▾ transcript  1–12/500  [−] [copy] [⤢]"
export const titleBar = (
  title: string,
  startLine: number,
  shown: number,
  total: number,
  collapsed: boolean,
): { text: string; hits: Hit[] } => {
  const controls: [string, Intent][] = [
    [collapsed ? '[+]' : '[−]', { type: 'toggle' }],
    ['[copy]', { type: 'copy' }],
    ['[⤢]', { type: 'expand' }],
  ]
  const range = total === 0 ? 'empty' : `${startLine + 1}–${startLine + shown}/${total}`
  let text = `${collapsed ? '▸' : '▾'} ${title}  ${range} `
  const hits: Hit[] = []
  for (const [label, intent] of controls) {
    text += ' '
    hits.push({ from: text.length, to: text.length + label.length, intent }) // columns this label occupies
    text += label
  }

  return { text, hits }
}

// Does a wheel tick at the pane body's visible `row` land on the viewport body?
//   - pointer rows count from the top of what the pane SHOWS, so add the
//     pane's own scroll offset to get the row in the pane's full tree
//   - the viewport body spans [top, top + height) in that tree
export const isOverViewport = (
  paneOffset: number,
  row: number,
  top: number,
  height: number,
): boolean => {
  const treeRow = paneOffset + row

  return treeRow >= top && treeRow < top + height
}
