import { expect, test } from 'claude-code/testing'

import { columnBadges, pathTail, toCountMode } from './display'

test('the active column is never labelled exact', () => {
  expect(columnBadges('exact')).toEqual({ static: 'exact', active: '≈ chars÷4' })
  expect(columnBadges('estimate')).toEqual({ static: '≈ est.', active: '≈ chars÷4' })
})

test('an unexpected setting falls back to the free mode', () => {
  expect(toCountMode('exact')).toBe('exact')
  expect(toCountMode('EXACT')).toBe('estimate')
  expect(toCountMode(undefined)).toBe('estimate')
})

test('paths keep the part that differs', () => {
  expect(pathTail('C:\\Users\\jared\\.claude\\rules\\ASKDONTASS.md')).toBe('…/rules/ASKDONTASS.md')
  expect(pathTail('C:/x/CLAUDE.md', 3)).toBe('C:/x/CLAUDE.md')
})
