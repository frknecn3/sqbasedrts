# Tests for `index.html` (Squad command)

The game is a single self-contained HTML file with no build step and no
dependencies. These tests run that file's real game code under Node by
supplying a minimal browser environment, so no browser, bundler or npm
install is needed.

```sh
node test/run.js                 # full run, ~15 s
node test/run.js --quick         # skips the long simulated matches, ~8 s
node test/run.js path            # only suites whose name contains "path"
```

Exit codes: `0` all checks passed, `1` at least one check failed (a summary of
failures is printed), `2` no suite matched the filter. Requires Node 18+.

## How it works

`harness.js` builds a stub DOM (elements, pointer/keyboard listeners, a
`ResizeObserver`, `requestAnimationFrame`) and a no-op Canvas2D context, then
evaluates the `<script>` block extracted from `index.html` unchanged inside a
`new Function`. Nothing in `index.html` is patched or re-implemented, so a run
exercises the same `frame()` → `update()` → `render()` path the browser does.

* **Real:** map generation, A*, squad/soldier simulation, combat, AI, capture
  logic, input handlers, HUD/minimap code, the sequence of canvas calls.
* **Stubbed:** rasterisation (every Canvas2D call is counted, not drawn), audio
  (`AudioContext` is absent, which the game already handles), and fonts.

Because drawing is stubbed, the performance numbers measure simulation plus
draw-call *submission* only — useful for catching regressions, not a
substitute for a real browser profile. Likewise nothing here can assert on
pixels; visual changes need a human (or a headless browser) to confirm.

Boot with `boot({ exposeInternals: true })` to get a handle on the game's
closure (squads, soldiers, flags, CP, `findPath`, `bp`, ...) for writing new
checks. `boot()` also returns `fire(el, type, event)` / `fireWin(type, event)`
to dispatch DOM events and `step(frames, dt)` to advance animation frames.

## What is covered

| Suite | Checks |
| --- | --- |
| boot & map generation | boots clean; starting squads/garrison; walkable starts, spawns, HQ and guard posts; generated buildings/cover/trees/flags; blocked-tile density; map determinism across boots |
| pathfinding | 1800+ random queries cross-checked against an independent BFS: returned paths never cross blocked tiles, always reach the goal, and never disagree with BFS on reachability; both HQs reachable from every start and spawn; A* heap headroom; buildings block line of sight |
| controls & interaction | deploy costs/cap/refusal; Ctrl+A, number keys, click and box select; group move orders and spread targets; formation cycling and wrap-around; stop orders; grenade mode and throw; pause freeze/resume; canvas resize; zoom, minimap and touch pan |
| objectives & win/lose | capture meter fills and wins; winning by wiping out the garrison after the last wave; losing the HQ; defeat panel; elimination with too little CP |
| combat & support | auto-acquisition and kills without orders; tracers; kill rewards; corpses; grenade projectile, splash damage and recall timer; HQ reinforcement and its cap; guard AI leashing home |
| stability | a 25-minute unattended match and a 20-minute randomised input fuzz (pointer, wheel, keyboard) with no exceptions, plus particle/bullet/corpse pool bounds and finite positions |
| performance budgets | simulation + draw-call submission per frame and canvas2D call volume under load |
| document structure | tag balance, every `$('id')` resolving, balanced CSS braces, a single inline script, no `console.*` left in game code, and the external-asset inventory |

## Known findings recorded by the suite

Two behaviours are asserted as *current* state rather than as desired state —
they are documented rather than fixed, since fixing them changes gameplay:

* **Unreachable pockets** — around 2% of walkable tiles sit in pockets that are
  walled off under the game's no-corner-cutting movement rule. `findPath`
  correctly returns an empty path for them, and a move order into one is
  silently dropped. The suite asserts the rate stays under 5%.
* **A* heap is unbounded** — `hN`/`hF` are fixed `N*N*8` typed arrays written
  without a bounds check (out-of-range typed-array writes are silently
  dropped). Peak usage measured on this map is ~200 of 12800 slots, so there
  is large headroom, and the suite asserts it stays under 50%.

The only external asset is the Tabler icon webfont loaded from jsdelivr; the
suite records it but does not require network access.
