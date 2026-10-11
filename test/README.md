# Tests

Headless test suite for the single-file game in `../index.html`. Node only — no
dependencies, no build step, nothing is served.

```bash
node test/run.js            # full run, ~40 s (includes two long simulated matches)
node test/run.js --quick    # skips the long matches, ~10 s
node test/run.js pathfind   # only suites whose name contains "pathfind"
```

Exit code: `0` all checks passed · `1` failures (listed at the end) · `2` bad suite filter.

## Files

| file | what it is |
| --- | --- |
| `harness.js` | boots `index.html` under a stub DOM/Canvas2D and hands back the game's own `window.SquadCommand.api` |
| `run.js` | the suite: 146 checks in 9 suites, written **entirely against the public API** |

## The harness

`index.html` runs in the browser: it looks up DOM ids, draws to a Canvas2D context,
listens for pointer/keyboard events and drives a `requestAnimationFrame` loop.
`harness.js` supplies exactly that much of a browser and **executes the real script
unmodified** — no source rewriting, no exports bolted on — so a run exercises the same
`frame()` / `update()` / `render()` code the browser runs.

```js
const { boot, loadGameScript } = require('./harness');

const g = boot();                  // boots the game, returns handles
const api = g.api;                 // window.SquadCommand.api - the public API

g.els.ovb                          // the "Deploy" overlay button (stub element)
g.fire(g.els.ovb, 'click');        // start the match through the real handler
g.fire(g.els.cv, 'pointerdown', { clientX: 300, clientY: 200, button: 2 });
g.fireWin('keydown', { code: 'KeyR' });
g.step(60);                        // 60 frames = 1 second at dt 1/60
api.error()                        // '' while healthy: the frame loop catches throws
```

* **real** — map generation, A\*, combat, AI, objectives, waves, input handling, HUD
  code paths, the full draw-call sequence.
* **stub** — rasterisation itself. Every Canvas2D call is counted and discarded, so
  tests can assert *how much* is drawn (`g.els.cv.ctx.calls`) and how fast the logic
  runs, but not on pixels.
* `step(n, dt)` advances `n` animation frames of `dt` seconds (default `1/60`), which
  is the only clock the game sees.

`loadGameScript()` returns `{ script, html }` when a test wants to inspect the source
(the `document structure` suite uses this to check tags, ids, CSS braces and that the
file stays self-contained).

## What the suites cover

| suite | checks |
| --- | --- |
| document structure | one file, balanced tags, every `$('id')` resolves, CSS balanced, no external scripts, header docs present |
| framework API | every registry populated, systems sorted, content lookups, `define*` validation, debug helpers |
| map & world | boot state, original seeding (8 squads / 40 soldiers), determinism (identical map hash across boots), HQ/zone/cover/LOS queries |
| pathfinding | 1,800 random queries cross-checked against an independent BFS (no illegal steps, no missed routes); pocket rate < 5% |
| content: units, roles & buildings | the demo content: spec-ops roster, unarmed medic healing, sniper profile/tracer, HQ reinforcement, spotter fog, outpost capture + bonus objective |
| controls & interaction | deploy cost/cap, selection, right-click orders, grenade mode, pause, zoom, minimap, resize, touch, HUD buttons built from content |
| objectives & win/lose | capture enemy HQ → Victory, lose your HQ → Defeat, wipe-outs, terminal outcomes, custom `api.end()` |
| extending the game through the public API | registers a new weapon/role/squad/building/behaviour/system/order/command/objective at runtime and plays with them |
| stability & performance | unattended long match, 15-minute input fuzz, pool bounds, frame budget, draw-call volume |

Everything it asserts is public API: a test that needs a situation builds it with
`api.debug.spawnUnit/spawnBuilding/teleportSquad/clearSquads/setCp/skipWaves`, and a
test that checks visuals checks the documented draw facade or HUD elements instead of
pixels.

## Notes for extending the game

* The extension points (units, roles, weapons, buildings + behaviours, map objects,
  systems, orders, objectives, waves, commands) and their JSDoc types are documented in
  the header of `index.html` (sections `[1/7]`…`[7/7]`).
* When you add content, add a check to the relevant suite — every check name is written
  to be readable as a statement about the game.
* `api.error()` returning non-empty means the frame loop caught a throw; the
  `stability` suite fails loudly in that case, which is the cheapest way to catch a
  broken content hook (e.g. the sniper AI bug where all four wrong assertions lived in
  the test, not the game).
