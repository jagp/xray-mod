// Display helpers shared by the text preview (/xray-mod-attribution) and the
// T5 pane. Pure: unit-tested in display.test.ts.

// How the numbers were counted, from the countMode setting (plugin.json
// userConfig): `estimate` sends no API calls; `exact` asks the engine for a
// full breakdown, which counts each tool schema and memory file exactly.
export type CountMode = 'estimate' | 'exact'

export const COUNT_MODES: readonly CountMode[] = ['estimate', 'exact']

// Read the setting defensively: anything unexpected falls back to estimate,
// the mode that costs nothing.
export const toCountMode = (value: unknown): CountMode => (value === 'exact' ? 'exact' : 'estimate')

// The signpost over each column, so nobody mistakes an estimate for a count:
//   - static: exact only when the engine counted it (full breakdown)
//   - active: always an estimate; no per-item count exists for a tool's
//     output or a skill's body, so it is never labelled exact
export const columnBadges = (mode: CountMode): { static: string; active: string } => ({
  static: mode === 'exact' ? 'exact' : '≈ est.',
  active: '≈ chars÷4',
})

// Long paths share their beginnings (every rules file starts
// C:\Users\...\.claude\rules), so cutting from the right hides the part that
// differs. Keep the tail instead: the last `segments` parts, prefixed "…".
export const pathTail = (path: string, segments = 2): string => {
  const parts = path.split(/[\\/]+/).filter(Boolean)

  return parts.length <= segments ? path : `…/${parts.slice(-segments).join('/')}`
}
