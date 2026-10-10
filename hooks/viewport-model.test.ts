import { expect, test } from 'claude-code/testing'

import { apply, clampOffset, INITIAL, isOverViewport, keyToIntent, titleBar } from './viewport-model'

// 500 lines through a 12-row window: the last valid offset is 488.
const TOTAL = 500
const HEIGHT = 12

test('the window never leaves the text', () => {
  expect(clampOffset(-5, TOTAL, HEIGHT)).toBe(0)
  expect(clampOffset(1000, TOTAL, HEIGHT)).toBe(488)
  expect(clampOffset(7, 5, HEIGHT)).toBe(0) // shorter than the window
})

test('keys scroll by line, page and to the ends', () => {
  const press = (key: string) => {
    const intent = keyToIntent(key, HEIGHT, TOTAL)
    return intent ? apply({ offset: 100, collapsed: false }, intent, TOTAL, HEIGHT).offset : null
  }
  expect(press('down')).toBe(101)
  expect(press('pageup')).toBe(88)
  expect(press('home')).toBe(0)
  expect(press('end')).toBe(488)
  expect(press('x')).toBe(null)
})

test('toggle collapses; copy and expand leave state alone', () => {
  expect(apply(INITIAL, { type: 'toggle' }, TOTAL, HEIGHT).collapsed).toBe(true)
  expect(apply(INITIAL, { type: 'copy' }, TOTAL, HEIGHT)).toEqual(INITIAL)
})

test('each title control is clickable exactly where its label is drawn', () => {
  const { text, hits } = titleBar('demo.txt', 0, 12, TOTAL, false)
  for (const hit of hits) {
    expect(['[−]', '[copy]', '[⤢]']).toContain(text.slice(hit.from, hit.to))
  }
  expect(text.startsWith('▾ demo.txt  1–12/500')).toBe(true)
})

test('a wheel tick counts as on the viewport only over its body rows', () => {
  // Body at tree rows 3..14; the pane scrolled down 2 rows.
  expect(isOverViewport(2, 0, 3, HEIGHT)).toBe(false) // tree row 2: title row
  expect(isOverViewport(2, 1, 3, HEIGHT)).toBe(true) //  tree row 3: first body row
  expect(isOverViewport(2, 13, 3, HEIGHT)).toBe(false) // tree row 15: below it
})
