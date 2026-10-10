# Implementation Plan: xray-mod v2

Approved 2026-10-10. Renamed from context-lens to xray-mod the same day
(the old name collided with larsderidder/context-lens in this exact niche).
Status: T0–T2 done and merged to develop; T3 in progress.

## Overview

Turn xray-mod from a readout into a context inspector. A two-column table
separates **static** overhead (listings, schemas, memory files: paid every
request) from **active** contributions (what each skill, tool and agent has
actually added to Messages), with every row drilling down to individual calls.
Leaves open in a reusable `Viewport` component. A **Turns** view adds a
per-turn ledger (what each turn and step added, with cache split) and
snapshots of the window at any past turn.

## Architecture decisions

- **Viewport is a `Client` surface module.** Panes scroll only as a whole
  (`$.ui.scroll` moves a site, not a box inside it), so a scrollable region in
  the pane needs a module holding its own offset. Content pages through its
  message port: `Client` props cap at 100k characters.
- **Attribution is a pure function** `classify(messages) → Contribution[]`
  over `$.session.messages()` (`toolUses` / `toolResults` per message;
  `{ agentId }` for a subagent), tested on fixture transcripts, then reconciled
  so the active total matches the engine's `Messages` row.
- **Counting mode** is a `countMode` setting plus an in-pane toggle, always
  signposted by a badge (`≈ estimate` / `exact · API`) and last-count time.
- **Jump-to-definition** goes through one `resolveHref(path, line)` chosen by a
  `jumpTarget` setting. Only `os` (`file:///`) is implemented; `vscode` and
  `claudectl` are declared stubs. The settings panel is deferred.
- **Per-turn data** comes from `turn.start` / `turn.complete` brackets and
  `turn.step`, whose resolved response carries each request's `usage`
  (uncached / cache-write / cache-read input, output).
- **Risk first:** the two spikes precede any UI built on them.

## Task list

### Phase 0: Home
- [x] **T0 · Repo** (S). `git init` on `develop`, copy the mod from the
  session's dev-mods folder, `.gitignore` the engine-generated
  `.claude-plugin/types/`. Accept: `claude plugin validate` + tests pass from
  the repo path. Note: this session hot-reloads dev-mods only; test from the
  repo via `CLAUDE_CODE_PLUGIN_DIRS` or `--plugin-dir`.

### Phase 1: De-risk
- [x] **T1 · Viewport spike** (M). Minimal `Client`, fixed height, wheel/arrow
  scroll, copy button → port → `$.ui.copy`, offset survives a redraw.
  Accept: 500 lines scroll on desktop and terminal; copy works.
  Files: `hooks/viewport.tsx`, `hooks/register.tsx`, test.
- [x] **T2 · Attribution spike** (M). `classify()` sorts prompt, assistant
  text, per-tool call/result, skill body (message after a `Skill` call),
  reminders/attachments. Accept: fixtures (incl. the `Skill(plugin-authoring)`
  launch-then-body shape) classify correctly.
  Files: `hooks/attribution.ts`, `hooks/attribution.test.ts`, `fixtures/`.

**Checkpoint A:** human review of both spikes. Closed 2026-10-10 on partial
evidence, at the owner's call to move forward:
- Verified live: `/xrm` opens the pane; `/xray-mod-attribution` attributed
  real rows (`skill_listing` 29.0k, `edited_text_file`, Bash ×7, Grep ×1).
- Not yet verified live: the viewport demo's six checks (wheel routing,
  keys, collapse, copy, expand) and a skill-body row marked `~`.
- Findings: rows arrive through `session.append` with door, origin,
  `isMeta` and attachment name, so attribution builds incrementally; a
  skill body is an `isMeta` row with origin tool `Skill` right after the
  call's result; hidden injections (`skill_listing`, `edited_text_file`,
  `total_tokens_reminder`) are attributable; the whole skill list is
  re-injected into Messages mid-session (≈29k, after the cwd change).
- Proposed, not yet agreed: shrink T14 (the walk is already incremental);
  make "injection" a top-level table category; lower the skill-body risk.

### Phase 2: Two-column table
- [ ] **T3 · Contribution model + reconcile** (S). Tree category → item →
  call; static from the breakdown, active from T2, scaled to `Messages`.
  Accept: columns sum to the /context total within 1%.
- [ ] **T4 · Count toggle + signpost** (S–M). `countMode` setting, pane
  toggle, badge. Includes verifying whether a per-block token-count op exists;
  if not, "exact" = exact per category, items estimated, and the badge says so.
- [ ] **T5 · Expandable table UI** (M). static / active / calls columns; row
  expand state in an atom.

### Phase 2b: Per-turn
- [ ] **T5a · Turn ledger** (S–M). Per turn and per step: usage (uncached /
  write / read / out), contribution delta, tools, duration. Capped at N turns.
- [ ] **T5b · Turns view** (M). Window · Turns tabs, turn list, step table,
  drill-down into viewports.
- [ ] **T5c · Turn snapshots + scrub** (M). Compact per-turn snapshot of the
  window composition; pick a past turn to see it in the two-column table.

**Checkpoint B:** table matches /context; toggle visible; turn ledger agrees
with per-step usage; human review.

### Phase 3: Viewport, finished
- [ ] **T6 · Viewport** (M). text / code / markdown modes, gutter,
  collapse/expand, port paging, mobile fallback.
- [ ] **T7 · Pop-out** (S). Expand opens a pane of its own; native scroll,
  Escape closes.
- [ ] **T8 · Jump-to-definition stub** (S). `resolveHref` + `jumpTarget`
  (default `os`), title-bar link.

### Phase 4: Drill-down leaves
- [ ] **T9 · Memory files** (S). File text via `$.fs.read`, source link.
- [ ] **T10 · Skills** (M). Listing text (static); each invocation's body and
  outputs (active); SKILL.md path discovery best-effort.
- [ ] **T11 · MCP / tools** (S–M). Schema (check whether `$.tool.list()`
  carries it); each call's input and result.
- [ ] **T12 · Messages** (M). Live transcript viewport, auto-follow.
- [ ] **T13 · Agents** (M). Status, live private transcript
  (`messages({ agentId })`), definition file (best-effort).

**Checkpoint C:** full drill-down end to end; human review.

### Phase 5: Polish
- [ ] **T14 · Performance** (S). Incremental transcript walk, hook budget.
- [ ] **T15 · Shipping prep** (S). README, `marketplace.json`.
- [ ] **T16 · Footer pill `⋐∿⋑`** (S). Replace the `◧` opener with the lens
  barrel `⋐∿⋑ 71%`; the wave inverts (`∿` ↔ `∽`) while a measurement runs and
  holds still when settled. Check the glyphs render in a real terminal.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `Client` behaves differently on desktop | High | T1 tests both surfaces; fallback to paged `Text` |
| Skill body misattributed by adjacency | Med | T2 fixtures; uncertain items marked `~` |
| No per-block exact count op | Med | T4 verifies; exact-per-category fallback, honest badge |
| Transcript walk slows each step | Med | Incremental walk (T14), debounce |
| Turn snapshots grow state | Med | Compact rows, cap N turns (T5c) |
| Repo not hot-reloaded by this session | Low | Env var / `--plugin-dir`, or edit in dev-mods and sync |

## Open questions

- Footer `◧ %` button and shift log carry over unchanged (assumed yes).
- Settings panel UI: deferred; add a task later or leave out of v2?
