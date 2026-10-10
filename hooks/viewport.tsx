import type { ClientModule } from 'claude-code'

import { keyToIntent, titleBar } from './viewport-model'
import type { ViewportProps } from './viewport-model'

// The reusable mini-viewport: a Client surface module.
//
// It is deliberately dumb. Each draw it:
//   1. builds the title row (and the click ranges of its controls) from props
//   2. (re)binds the key and pointer listeners so they see this draw's props
//   3. draws the title plus the visible slice of lines, with a line gutter
// It keeps no scroll state of its own: every change is posted to the hooks
// (register.tsx, the `ui.message` hook), which update the `viewports` atom
// and redraw this instance with its next slice. See viewport-model.ts.
const Viewport: ClientModule<ViewportProps> = (props, surface) => {
  const { Box, Text } = surface.elements
  const bar = titleBar(props.title, props.startLine, props.lines.length, props.total, props.collapsed)

  // Keys arrive only while a click has given this instance the focus.
  surface.onKey(event => {
    const intent = keyToIntent(event.key, props.height, props.total)
    if (intent) surface.post(intent)
  })

  // Clicks on the title row (y = 0) hit the controls by column range.
  surface.onPointer(event => {
    if (event.type !== 'down' || event.y !== 0) return
    const hit = bar.hits.find(one => event.x >= one.from && event.x < one.to)
    if (hit) surface.post(hit.intent)
  })

  // Gutter: right-aligned 1-based line numbers, as wide as the largest one.
  // Lines are cut to the region's width so one long line never wraps into two
  // rows, which would throw off the hooks' row math (isOverViewport).
  const gutterWidth = String(props.total).length
  const width = surface.columns > 0 ? surface.columns : 200 // 0 before the first layout
  const textWidth = Math.max(1, width - gutterWidth - 3) //     3 = " │ "
  const body = props.collapsed
    ? []
    : props.lines.map((line, index) =>
        Text({
          children: `${String(props.startLine + index + 1).padStart(gutterWidth)} │ ${line.slice(0, textWidth)}`,
        }),
      )

  return Box({
    flexDirection: 'column',
    children: [Text({ bold: true, children: bar.text }), ...body],
  })
}

export default Viewport
