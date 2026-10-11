# Extending Squad Command

`index.html` is a single self-contained file: the whole game, its type definitions, its
content and a public extension API. There is no build step, no server and no module
loader — you edit the file (or run a script against the page) and reload.

This document is the short version for a reader (human or LLM) who wants to add content
without reading all 2,400 lines first. The authoritative details live in the header of
`index.html`, sections `[1/7]` … `[7/7]`.

## 30-second orientation

```
index.html
  [1/7] header      all JSDoc typedefs: WeaponSpec, RoleSpec, UnitSpec, BuildingSpec,
                    BuildingBehaviour, ObjectiveSpec, OrderDef, System, MapObjectSpec, ...
  [2/7] framework   helpers, registries (REG), define* functions, GAME design constants
  [3/7] world       tiles, map generation, A*, line of sight, fog of war
  [4/7] content     <-- the demo content: weapons, roles, units, behaviours, buildings,
                        structures, objects, factions, orders, objectives, waves
  [5/7] systems     the simulation rules, each `{ id, order, run(dt, api) }`
  [6/7] render      canvas painters + the `draw`/`paint` facades content hooks receive
  [7/7] input/HUD   pointer + keyboard handling, HUD, boot, and the PUBLIC API object
```

Everything shared with the outside world hangs off one global:

```js
window.SquadCommand.api           // the live API
window.SquadCommand.registries    // the raw registration arrays (units, roles, systems, ...)
window.SquadCommand.assets        // shared tables: WEAPONS, OBJECT, BEHAVIOURS, FORMS, AI, ...
```

Content inside the file is written against exactly the same `api` object, so the recipes
below are valid both in-file (right after the framework section) and from a `<script>`
tag / console at runtime.

## Recipes

### A new squad type

```js
api.defineWeapon({ id: 'smg', name: 'SMG', range: 6.5, burst: 4, iv: .08, c0: .5, c1: .9,
                   dmg: 9, acc: .45, mag: 40, rt: 2 });
api.defineRole({ id: 'shock', name: 'Shock trooper', weapon: 'smg', sprite: 'soldier' });
const type = api.defineUnit({
  id: 'hunters', name: 'Hunter squad', cost: 150, count: 5, speed: 2.2,
  formation: 1, grenade: 12,
  roles: [{ id: 'shock' }, { id: 'shock' }, { id: 'shock' }, { id: 'shock' }, { id: 'shock' }],
  portrait: { head: '#7a5f2f', helm: '#5a4520', skin: '#c99a6e', band: '#ffd79a' },
  notes: ['free-form notes for AI/LLM readers; the game never reads them'],
  onDeploy: (squad, api) => { /* optional hook */ },
});
api.factions().player.units.push('hunters');   // make it deployable
api.ui.buttons();                              // rebuild the deploy bar
```

* `roles` is one entry per soldier; a shorter list repeats its last entry.
* `cost` is in command points, `speed` in tiles/second, `count` soldiers per squad.
* Deploy it with `api.deployUnit('hunters')`, or let the player press its button / `R`.

### A new building behaviour

A behaviour is a small rules object a building carries; hooks are called by the framework.

```js
api.defineBuildingBehaviour('beacon', {
  vision: (inst, api, bv) => bv.radius,                    // fog radius for its owner (0 = none)
  tick(inst, dt, api, bv) { inst.charge = (inst.charge || 0) + dt * bv.rate },
  draw(inst, draw, time, api, bv) { draw.ring(inst.x, inst.y, bv.radius, 'rgba(150,220,255,.5)', .3) },
  captured(inst, api, bv) { /* called when the team flips */ },
});
```

`bv` is this building's own entry from `behaviours: [...]`, so one behaviour can be reused
at different radii/rates on different buildings.

### A new building type

```js
api.defineBuilding({
  id: 'beacon', name: 'Beacon', w: 1, h: 1, height: 20, style: 0, team: 0,
  blocks: true, cover: true, capturable: false,      // any of these can be overridden
  behaviours: [{ id: 'beacon', radius: 9, rate: 2 }],
});
api.debug.spawnBuilding('beacon', 12, 12, api.teams.player);
```

Solid buildings block movement and line of sight and give cover. `capturable: true` makes
them flip team when held (see the built-in `outpost`), `data` carries free-form tunables.

### A new simulation rule

```js
api.defineSystem({ id: 'weather', order: api.ORDER.OBJECTIVES + 1, run(dt, api) { /* ... */ } });
```

`order` decides when it runs (`REG.systems` stays sorted). See the ORDER table in the
header; the useful anchors are `-100` fog, `-50` unit behaviour, `0` structures,
`50` cleanup, `60` objectives, `70` campaign, `80` retention.

### A new order, command, objective or wave

```js
api.defineOrder({ id: 'regroup', key: 'KeyQ', name: 'Regroup',
  start(squads, x, y, api) { /* issued: squads + cursor */ },
  run(squad, order, dt, api) { /* every frame while squad.order.type === 'regroup' */ } });

api.defineCommand({ id: 'salute', key: 'KeyZ', label: 'Salute', run(api) { api.msg('o7') } });

api.defineObjective({ id: 'hold-bridge', result: 'victory', hold: false,
  test: (ctx, api) => /* boolean */ false,
  with: [{ at: 0, run: (ctx, api) => api.end(true, 'Bridge held') }] });

api.registerWave({ delay: 55, squads: [{ unit: 'raiders', count: 2 }], message: 'Raiders inbound' });
```

A command with a key wins over an order with the same key (that is how `KeyG` arms the
grenade cursor before the grenade order runs).

## Driving the game from a test or a script

```js
const api = window.SquadCommand.api;
api.state(); api.playing(); api.clock(); api.error();        // health
api.debug.setCp(500); api.debug.setWaveTimer(1e9);           // set a situation up
api.debug.spawnUnit('raiders', api.teams.enemy, 20, 20, 'guard');
api.debug.spawnBuilding('watchtower', 30, 30, api.teams.player);
api.debug.teleportSquad(api.playerSquads()[0], 12.5, 12.5);
api.debug.clearSquads(api.teams.enemy); api.debug.skipWaves(6);

api.view.tile(i, j); api.view.uptodate();                    // fog (0 unseen, 1 seen, 2 visible)
api.ui.screenToWorld(px, py);                                // canvas pixels -> tiles
api.ui.worldToScreen(x, y);                                  // tiles -> canvas pixels
api.findPath(x0, y0, x1, y1); api.los(a, b, c, d); api.walkable(x, y);

api.defineUnit(spec) / defineRole / defineWeapon / defineBuilding / defineBuildingBehaviour
  / defineObject / defineStructure / defineOrder / defineSystem / defineObjective
  / defineCommand / registerWave                              // all registration entry points
```

`api.error()` returns the last exception the frame loop caught (and `''` when healthy),
which is the fastest way to notice a broken content hook.

## Invariants the tests defend

`node test/run.js` (see `test/README.md`) checks, among other things:

* one self-contained file — balanced tags, no external scripts, every `$('id')` resolves;
* the original campaign is intact: map generation is deterministic (identical `block`
  hash across boots) and the seeding matches the pre-framework game — 8 squads x
  5 soldiers, roster `sgt/rifle/rifle/rifle/lmg`, waves `1,1,2,1,2,2`, 70 s opener;
* pathfinding never crosses blocked tiles and never misses a route BFS finds;
* the demo content works: medic heals, sniper outranges rifles, spotter reveals fog,
  outposts capture and delay waves;
* a long unattended match and a 15-minute input fuzz run without a runtime error;
* new content can be registered at runtime through the public API alone.

Add a check to the matching suite whenever you add content — the check names are written
to read as statements about the game.
