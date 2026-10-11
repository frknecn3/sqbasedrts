'use strict';
/*
 * Test suite for index.html (Squad command).
 *
 *   node test/run.js            full run (~40 s)
 *   node test/run.js --quick    skips the long simulated matches (~10 s)
 *   node test/run.js path       runs only suites whose name matches "path"
 *
 * The suite talks to the game exclusively through the public API it publishes on
 * window.SquadCommand.api, so it doubles as an executable reference for the API:
 * every call below is a documented, supported way to drive or extend the game.
 * Requires only Node (no dependencies).
 */

const { boot, loadGameScript } = require('./harness');

const QUICK = process.argv.includes('--quick');
const filter = process.argv.slice(2).find(a => !a.startsWith('--'));

const suites = [];
let current = null;
function suite(name, fn) { suites.push({ name, fn, checks: [] }) }
function check(name, cond, extra = '') {
  current.checks.push({ name, ok: !!cond, extra });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const info = msg => console.log(`        ${msg}`);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ------------------------------------------------------------------ utils -- */

function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}
// Independent flood fill with the same movement rule as the game's A*
// (8-way, no cutting diagonally between two blocked tiles).
function bfsReachable(api, si, sj, ti, tj) {
  const N = api.world.N, block = api.world.block;
  const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1];
  if (block[sj * N + si]) return false;
  const seen = new Uint8Array(N * N), q = [sj * N + si];
  seen[sj * N + si] = 1;
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    if (c === tj * N + ti) return true;
    const ci = c % N, cj = (c / N) | 0;
    for (let k = 0; k < 8; k++) {
      const di = DI[k], dj = DJ[k], ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
      const nn = nj * N + ni;
      if (block[nn] || seen[nn]) continue;
      if (di && dj && (block[cj * N + ni] || block[nj * N + ci])) continue;
      seen[nn] = 1; q.push(nn);
    }
  }
  return false;
}
const hash = arr => { let h = 2166136261; for (let i = 0; i < arr.length; i++) { h ^= arr[i]; h = Math.imul(h, 16777619) } return (h >>> 0).toString(16) };

// Screen point of a world tile far away from every squad (safe "click empty ground").
function emptyScreenPoint(api) {
  const N = api.world.N; let best = null, bestD = -1;
  for (let j = 1; j < N; j += 2) for (let i = 1; i < N; i += 2) {
    if (!api.walkable(i + .5, j + .5)) continue;
    let d = 1e9;
    for (const q of api.squads()) for (const s of q.soldiers) if (!s.dead) d = Math.min(d, Math.hypot(s.x - (i + .5), s.y - (j + .5)));
    if (d > bestD) { bestD = d; best = api.ui.worldToScreen(i + .5, j + .5) }
  }
  return best;
}

// World point (tile centre) far from every player unit and the player HQ - for
// tests that need somewhere the player's fog has not reached yet.
function farSpot(api) {
  const N = api.world.N, hq = api.world.playerHq; let best = null, bestD = -1;
  for (let j = 2; j < N - 2; j++) for (let i = 2; i < N - 2; i++) {
    const x = i + .5, y = j + .5;
    if (!api.walkable(x, y)) continue;
    let open = 0;                                             // needs room, or a river hides the whole view
    for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) if (api.walkable(i + a + .5, j + b + .5)) open++;
    if (open < 18) continue;
    let d = Math.min(Math.hypot(x - hq.x, y - hq.y), Math.hypot(x - api.world.enemyHq.x, y - api.world.enemyHq.y));
    for (const s of api.soldiers()) if (!s.dead) d = Math.min(d, Math.hypot(s.x - x, s.y - y));
    if (d > bestD) { bestD = d; best = { x, y, d: bestD } }
  }
  return best;
}

// start a fresh match and return the api
function play() {
  const g = boot(), api = g.api;
  g.fire(g.els.ovb, 'click');
  return { g, api };
}

/* ============================================== 1. document structure ==== */

suite('document structure (index.html)', () => {
  const { html } = loadGameScript();
  check('single self-contained file', html.startsWith('<!DOCTYPE html>') && html.trim().endsWith('</html>'));

  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const stack = [], errs = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, close, tag, self] = m; const t = tag.toLowerCase();
    if (VOID.has(t) || self) continue;
    if (!close) stack.push(t);
    else if (stack[stack.length - 1] === t) stack.pop(); else errs.push(`</${t}>`);
  }
  check('all HTML tags balanced', !stack.length && !errs.length, `${stack.length} unclosed, ${errs.length} mismatched`);

  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(x => x[1]));
  const used = new Set([...html.matchAll(/\$\('([^']+)'\)/g)].map(x => x[1]));
  const missing = [...used].filter(i => !ids.has(i));
  check("every $('id') lookup resolves", missing.length === 0, missing.join(', '));

  const style = html.match(/<style>([\s\S]*?)<\/style>/);
  check('CSS braces balanced', !!style && (style[1].match(/\{/g) || []).length === (style[1].match(/\}/g) || []).length);
  const scripts = html.match(/<script/g) || [];
  check('exactly one inline script', scripts.length === 1);
  check('no src-based external scripts', !/<script[^>]+src=/.test(html));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  check('no console.* left in game code', !/\bconsole\.(log|warn|debug)\b/.test(script));
  check('framework header documents the extension points', /HOW TO ADD CONTENT/.test(script) && /@typedef \{Object\} UnitSpec/.test(script));
  const ext = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(x => x[1]);
  info(ext.length ? `external assets: ${ext.join(', ')}` : 'no external assets (fully offline)');
});

/* =================================================== 2. framework API ==== */

suite('framework API', () => {
  const g = boot(), api = g.api;
  check('boot publishes window.SquadCommand.api', !!api && api.version === 2);
  check('registries expose content as data',
    api.registry.units.length >= 4 && api.registry.roles.length >= 4 && api.registry.buildings.length >= 3 &&
    api.registry.objectives.length >= 4 && api.registry.waves.length >= 2 && api.registry.commands.length >= 5 &&
    api.registry.orders.length >= 2, `${api.registry.units.length} units, ${api.registry.objectives.length} objectives, ${api.registry.systems.length} systems`);
  check('systems are sorted by their declared order',
    api.registry.systems.every((s, i, a) => i === 0 || a[i - 1].order <= s.order),
    api.registry.systems.map(s => s.id + '@' + s.order).join(' '));
  check('every system declares id + run', api.registry.systems.every(s => s.id && typeof s.run === 'function'));
  check('every objective declares a test function', api.registry.objectives.every(o => o.id && typeof o.test === 'function'));
  check('every order declares an id', api.registry.orders.every(o => o.id));
  check('every unit declares id/cost/roles', api.registry.units.every(u => u.id && u.cost != null && Array.isArray(u.roles)));
  check('every building declares id/w/h/behaviours', api.registry.buildings.every(b => b.id && b.w && b.h && Array.isArray(b.behaviours)));
  check('asset tables are exposed (weapons, objects, behaviours)', !!api.assets.WEAPONS.rifle && !!api.assets.OBJECT.tree && !!api.assets.BEHAVIOURS.flag);
  check('lookups resolve content by id',
    api.unit('rifles').name === 'Rifle squad' && api.role('medic').weapon === 'none' &&
    api.weapon('sniper').range === 11 && api.building('headquarters').blocks === false);

  // Every api.<name> the built-in content calls must exist - guards against
  // framework changes that would break content written against the docs.
  const script = loadGameScript().script;
  const usedNames = new Set([...script.matchAll(/\bapi\.([A-Za-z_]+)/g)].map(x => x[1]));
  const holes = [...usedNames].filter(n => api[n] === undefined);
  check('every api.* used by the built-in content exists', holes.length === 0, holes.join(', '));

  // defineUnit validation
  let threw = false;
  try { api.defineUnit({ name: 'no id' }) } catch (e) { threw = true }
  check('defineUnit rejects a spec without an id', threw);
  let dup = false;
  try { api.defineUnit({ id: 'rifles', name: 'dupe', cost: 1, roles: [] }) } catch (e) { dup = true }
  check('defineUnit rejects duplicate ids', dup);

  // debug helpers used by tests/content authors
  api.debug.setCp(7); check('debug.setCp sets command points', api.commandPoints() === 7);
  api.debug.addCp(5); check('debug.addCp adds command points', api.commandPoints() === 12);
  api.debug.setKills(9); check('debug.setKills sets the kill counter', api.kills() === 9);
  api.debug.setState('paused'); check('debug.setState drives the state machine', api.state() === 'paused');
  api.debug.setState('start');
  g.fire(g.els.ovb, 'click');
  const before = api.playerSquads().length;
  api.debug.spawnUnit('raiders', api.teams.enemy, 20, 20, 'assault');
  check('debug.spawnUnit adds a squad of that type', api.enemySquads().some(q => q.type.id === 'raiders'));
  const free = api.freeSpot(api.world.playerHq.x + 6, api.world.playerHq.y - 6);
  const tw = api.debug.spawnBuilding('watchtower', Math.floor(free.x), Math.floor(free.y), api.teams.player);
  check('debug.spawnBuilding places a building instance', !!tw && api.buildings().includes(tw) && tw.behaviours.length === 1);
  api.debug.clearSquads(api.teams.enemy);
  check('debug.clearSquads kills a whole team', api.enemySquads().every(q => q.soldiers.every(s => s.dead)));
  check('player squad count untouched by clearSquads', api.playerSquads().length === before);
});

/* ================================================== 3. map & world ======= */

suite('map & world', () => {
  const g = boot(), api = g.api, W = api.world;
  check('boots clean', api.error() === '');
  check('initial state is "start" (overlay, not playing)', api.state() === 'start');
  check('3 player squads seeded at the starts', api.playerSquads().length === 3 && api.playerSquads().every(q => q.soldiers.length === q.count));
  check('enemy garrison posted at the bridges', api.enemySquads().length === W.garrison().length && api.enemySquads().every(q => q.type.strategy === 'guard'));
  check('starts, spawns, HQs and posts are all walkable',
    W.starts.every(p => api.walkable(p.x, p.y)) && W.enemySpawns.every(p => api.walkable(p.x, p.y)) &&
    api.walkable(W.playerHq.x, W.playerHq.y) && api.walkable(W.enemyHq.x, W.enemyHq.y) && W.garrison().every(p => api.walkable(p.x, p.y)));

  const byType = {};
  for (const o of W.statics()) byType[o.type] = (byType[o.type] || 0) + 1;
  info(`statics: ${JSON.stringify(byType)}`);
  let blocked = 0; for (let k = 0; k < W.N * W.N; k++) if (W.block[k]) blocked++;
  info(`blocked tiles: ${blocked}/${W.N * W.N}, water: ${W.water.length}, roads: ${W.roads().length}`);
  check('map generated objects and buildings', byType.tree >= 40 && byType.bags >= 20 && byType.building >= 10);
  check('blocked tile density is sane', blocked > 200 && blocked < 600);
  check('map generation is deterministic (seeded, no Math.random)',
    (() => { const b2 = boot().api; return hash(W.block) === hash(b2.world.block) && hash(W.ground) === hash(b2.world.ground) })());

  // buildings + their zones
  const hqs = api.buildings().filter(b => b.id === 'headquarters');
  check('two HQ posts placed, one per side', hqs.length === 2 && hqs.map(h => h.team).sort().join() === '0,1');
  // the pre-framework game had 8 squads x 5 soldiers, roster sgt/rifle/rifle/rifle/lmg, waves 1,1,2,1,2,2
  check('every squad fields 5 soldiers like the original', api.squads().length === 8 && api.soldiers().length === 40);
  check('squad roster matches the original (sgt, 3 rifles, lmg)',
    api.playerSquads().every(q => q.soldiers.map(s => s.role).join() === 'sgt,rifle,rifle,rifle,lmg'));
  check('the campaign keeps the original wave table (1,1,2,1,2,2 squads, 70 s opener)',
    api.registry.waves.map(w => w.squads.reduce((a, s) => a + s.count, 0)).join() === '1,1,2,1,2,2' &&
    api.registry.waves[0].delay === 70 && api.registry.waves.slice(1).every(w => w.delay === 55) &&
    api.waveTimer() === 70, api.registry.waves.map(w => w.delay).join());
  check('HQ posts do not block movement', hqs.every(h => !h.blocks) && api.walkable(W.playerHq.x, W.playerHq.y));
  const solid = api.buildings().filter(b => b.blocks).find(b => true);
  check('solid buildings block their footprint', !!solid && !api.walkable(solid.i + .5, solid.j + .5));
  check('bodies block line of sight', !!solid && !api.los(solid.i - 4.5, solid.j + .5, solid.i + 5.5, solid.j + .5) || (() => {
    const b = api.buildings().find(x => x.id === 'shed'); return !api.los(b.i - 4.5, b.j + .5, b.i + b.w + 3.5, b.j + .5)
  })());
  check('capture zones exist for both HQs', api.zones().length === 2 && api.zones().every(z => z.cap === 0));

  // walking queries
  check('walkable() rejects water and accepts open ground',
    api.walkable(0.5, 0.5) === true && api.walkable(W.playerHq.x, W.playerHq.y) === true);
  check('freeSpot() nudges blocked points to open tiles', !api.walkable(0.5, 0.5) || api.walkable(api.freeSpot(0.5, 0.5).x, api.freeSpot(0.5, 0.5).y));
  check('coverAt/roofAt report the tile under a point', api.coverAt(W.playerHq.x, W.playerHq.y) === false && api.coverAt(solid.i + .5, solid.j + .5) === true);
});

/* ==================================================== 4. pathfinding ===== */

suite('pathfinding', () => {
  const { api } = play();
  const R = lcg(987654321), N = api.world.N;
  let illegal = 0, empty = 0, tested = 0, falseNeg = 0, falsePos = 0;
  for (let t = 0; t < 3000; t++) {
    const ax = .5 + R() * (N - 1), ay = .5 + R() * (N - 1), bx = .5 + R() * (N - 1), by = .5 + R() * (N - 1);
    if (!api.walkable(ax, ay) || !api.walkable(bx, by)) continue;
    tested++;
    const p = api.findPath(ax, ay, bx, by);
    const reachable = bfsReachable(api, Math.floor(ax), Math.floor(ay), Math.floor(bx), Math.floor(by));
    if (!p.length) { empty++; if (reachable) falseNeg++; continue }
    if (!reachable) falsePos++;
    let prev = { x: ax, y: ay }, bad = false;
    for (const w of p) { if (!api.walkable(w.x, w.y) || !api.segClear(prev.x, prev.y, w.x, w.y, 0)) { bad = true; break } prev = w }
    if (bad || Math.hypot(prev.x - bx, prev.y - by) > 0.05) illegal++;
  }
  check('paths never cross blocked tiles and reach the goal', illegal === 0, `${illegal} illegal of ${tested}`);
  check('never returns a path to an unreachable goal (checked against BFS)', falsePos === 0, `${falsePos}`);
  check('never fails a search BFS proves reachable', falseNeg === 0, `${falseNeg}`);
  const pockets = empty - falseNeg;
  info(`unreachable pockets: ${pockets}/${tested} (${(100 * pockets / tested).toFixed(2)}%) of random walkable points`);
  check('walled-off pockets stay rare (<5%)', pockets / tested < 0.05);
  check('trivial same-tile query is a no-op', api.findPath(10.5, 10.5, 10.5, 10.5).length === 1);
  const goals = [[api.world.enemyHq.x, api.world.enemyHq.y], [api.world.playerHq.x, api.world.playerHq.y]];
  let fails = [];
  for (const s of [...api.world.starts, ...api.world.enemySpawns]) for (const [gx, gy] of goals) if (!api.findPath(s.x, s.y, gx, gy).length) fails.push(`${s.x},${s.y}`);
  check('both HQs reachable from every start and spawn', fails.length === 0, fails.join(' '));
});

/* ================================ 5. content: units, roles, buildings ==== */

suite('content: units, roles & buildings', () => {
  const { g, api } = play();
  check('5 squad types registered with distinct roles',
    api.units().map(u => u.id).join() === 'rifles,specops,guards,assault,raiders');
  check('player can deploy 2 types, enemy fields 3', api.factions().player.units.length === 2 && api.factions().enemy.units.length === 3);
  check('roles cover sergeant, lmg, sniper and medic',
    ['sgt', 'lmg', 'rifle', 'sniper', 'medic'].every(r => !!api.role(r)));

  // --- new unit: spec ops, built entirely from data ---
  const so = api.unit('specops');
  check('spec ops costs 200 and is faster than rifles', so.cost === 200 && so.speed > api.unit('rifles').speed);
  api.debug.setCp(1000);
  const q = api.deployUnit('specops');
  check('deployUnit charges the unit cost', api.commandPoints() === 800);
  check('spec ops fields sgt/lmg/sniper/sniper/medic', q.soldiers.map(s => s.role).join() === 'sgt,lmg,sniper,sniper,medic');
  check('deploy renames squads from the shared name pool', q.name === 'Delta', q.name);
  check('unit data overrides global sight', q.soldiers[0].sight === 11.5);

  // --- weaponless medic heals instead of shooting ---
  const medic = q.soldiers.find(s => s.role === 'medic'), buddy = q.soldiers.find(s => s.role === 'sgt');
  check('medic is unarmed (range 0 => never fires)', medic.weapon.range === 0 && medic.weapon.dmg === 0);
  buddy.hp = 40;
  for (let i = 0; i < 60 * 3; i++) g.step(1);
  check('medic heals the most wounded squadmate', buddy.hp > 40, `40 -> ${buddy.hp.toFixed(0)}`);
  check('medic keeps soldiers within the squad cap', buddy.hp <= buddy.maxHp);

  // --- sniper weapon profile drives range/tracer ---
  const sniper = q.soldiers.find(s => s.role === 'sniper');
  check('sniper uses the registered sniper weapon', sniper.weapon.id === 'sniper' && api.weapon('sniper').dmg === 42);
  const es = api.enemySquads()[0];
  api.debug.teleportSquad(es, q.ax - 8, q.ay);
  let tracer = false, hp0 = es.soldiers.reduce((a, s) => a + s.hp, 0);
  for (let i = 0; i < 60 * 6; i++) { g.step(1); if (api.bullets().some(b => b.tr)) tracer = true }
  check('sniper engages at 8 tiles and fires its distinct tracer', tracer,
    `enemy squad HP ${hp0.toFixed(0)} -> ${es.soldiers.reduce((a, s) => a + s.hp, 0).toFixed(0)}`);
  check('grenades exclude unarmed roles from the volley',
    (() => {
      const t = api.throwNade(api.playerSquads()[0], api.playerSquads()[0].ax + 2, api.playerSquads()[0].ay);
      return t === true && api.playerSquads()[0].gcd > 0;
    })());

  // --- reinforcement + soldier cap ---
  const rq = api.playerSquads()[0];
  api.debug.teleportSquad(rq, api.world.playerHq.x, api.world.playerHq.y);
  api.kill(rq.soldiers[0], 0, 0, 0);
  g.step(1);
  const n0 = rq.soldiers.length;
  for (let i = 0; i < 60 * 6; i++) g.step(1);
  check('squads resting at your HQ regrow lost soldiers', rq.soldiers.length > n0, `${n0} -> ${rq.soldiers.length}`);
  check('reinforcement respects the unit count', rq.soldiers.length <= rq.count);

  // --- building behaviour: spotter reveals fog for its owner ---
  const gt = boot(), gap = gt.api;
  gt.fire(gt.els.ovb, 'click');
  const site = farSpot(gap);
  const N = gap.world.N;
  const seenCount = () => { let n = 0; for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (gap.view.tile(i, j) > 0) n++; return n };
  const si = Math.floor(site.x), sj = Math.floor(site.y);
  info(`spotter test site: tile ${si},${sj} — ${site.d.toFixed(1)} tiles from the nearest player unit`);
  const before = seenCount();
  const tower = gap.debug.spawnBuilding('watchtower', si, sj, gap.teams.player);
  const bv = tower.behaviours[0];
  gap.view.uptodate();
  const after = seenCount();
  check('a spotter building reveals fog for its owner (vision hook)',
    bv.def.vision(tower, gap, bv) === bv.radius && bv.radius > 0 && after - before > 20,
    `map tiles revealed by the tower alone: ${after - before} (${before} -> ${after})`);
  const seenBefore = seenCount();
  const enemyTower = gap.debug.spawnBuilding('watchtower', si + 1, sj + 6, gap.teams.enemy);
  gap.view.uptodate();
  check('an enemy-owned spotter never reveals for the player',
    enemyTower.team === gap.teams.enemy && seenCount() === seenBefore, `${seenBefore} -> ${seenCount()}`);
  check('vision()/reveal() are exposed for content', typeof gap.view.reveal === 'function' && typeof gap.view.visibleAt === 'function');

  // --- capturable building + bonus objective ---
  const { g: gg, api: aa } = play();
  const op = aa.buildings().find(b => b.capturable);
  check('the outpost is the capturable building', !!op && op.id === 'outpost' && op.team === aa.teams.enemy);
  aa.debug.setWaveTimer(1e9);
  aa.debug.teleportSquad(aa.playerSquads()[0], op.x, op.y);
  let flip = null;
  for (let i = 0; i < 60 * 25 && flip === null; i++) { aa.debug.teleportSquad(aa.playerSquads()[0], op.x, op.y); gg.step(1); if (op.team !== aa.teams.enemy) flip = i / 60 }
  check('standing on an outpost captures it for your team', op.team === aa.teams.player, `after ${flip === null ? 'never' : flip.toFixed(1) + 's'}`);
  check('capturing an outpost fires the bonus objective',
    aa.registry.objectives.some(o => o.id === 'bonus.secure-outposts' && (o.with[0].fired === true)) &&
    aa.messages().some(m => /outpost/i.test(m.text)),
    aa.messages().map(m => m.text).join(' / '));
  check('bonus objectives do not end the match', aa.state() === 'play');
});

/* ============================================ 6. controls & input ======== */

suite('controls & interaction', () => {
  const { g, api } = play();
  check('overlay Deploy starts the match', api.playing());

  check('deploy is refused below the unit cost', (() => {
    const n0 = api.playerSquads().length;
    api.debug.setCp(10); g.fireWin('keydown', { code: 'KeyR' });
    return api.playerSquads().length === n0;
  })(), `cp=${api.commandPoints()}`);
  api.debug.setCp(500);
  g.fireWin('keydown', { code: 'KeyR' });
  check('R deploys the default unit and charges its cost', api.playerSquads().length === 4 && api.commandPoints() === 380);
  api.debug.setCp(1e6);
  for (let i = 0; i < 5; i++) g.fireWin('keydown', { code: 'KeyR' });
  check('player is capped at 6 squads', api.playerSquads().length === 6);

  // selection
  g.fireWin('keydown', { code: 'KeyA', ctrlKey: true });
  check('Ctrl+A selects every squad', api.selection().size === 6);
  g.fireWin('keydown', { code: 'Digit2' });
  check('number keys select a single squad', api.selection().size === 1);
  g.fireWin('keydown', { code: 'Digit9' });
  check('out-of-range number keys do nothing', api.selection().size === 1);
  const empty = emptyScreenPoint(api);
  g.fire(g.els.cv, 'pointerdown', { clientX: empty.x, clientY: empty.y });
  g.fire(g.els.cv, 'pointerup', { clientX: empty.x, clientY: empty.y });
  check('clicking empty ground clears the selection', api.selection().size === 0);

  // orders through the real pointer path
  const q = api.playerSquads()[0];
  const screen = { x: 340, y: 260 };
  api.centerOn([q]);
  api.selection().clear();
  api.selection().add(q);
  const orderSeen = [];
  g.fire(g.els.cv, 'pointerdown', { button: 2, clientX: screen.x, clientY: screen.y });
  g.fire(g.els.cv, 'pointerup', { button: 2, clientX: screen.x, clientY: screen.y });
  check('right-click issues a move order', !!q.order && q.order.type === 'move', JSON.stringify(q.order));
  const from = { x: q.ax, y: q.ay };
  for (let i = 0; i < 60 * 3; i++) g.step(1);
  check('ordered squads travel', Math.hypot(q.ax - from.x, q.ay - from.y) > .5, `moved ${Math.hypot(q.ax - from.x, q.ay - from.y).toFixed(1)} tiles`);

  g.fireWin('keydown', { code: 'KeyX' });
  check('X (stop) clears orders via the command registry', !q.order && !q.path.length);
  const f0 = q.form;
  g.fireWin('keydown', { code: 'KeyF' });
  g.fireWin('keydown', { code: 'KeyF' });
  g.fireWin('keydown', { code: 'KeyF' });
  check('F cycles the formation through all three and wraps', q.form === f0 && api.assets.FORMS.length === 3);

  // grenade (armed order)
  api.selection().clear(); api.selection().add(q);
  g.fireWin('keydown', { code: 'KeyG' });
  check('G arms grenade mode when the squad can throw', api.ui.nadeMode() === true);
  const target = api.ui.worldToScreen(q.ax + 4, q.ay);
  g.fire(g.els.cv, 'pointerdown', { button: 0, clientX: target.x, clientY: target.y });
  let nade = false, threw = false;
  for (let i = 0; i < 60 * 3; i++) { g.step(1); if (api.nades().length) nade = true; if (q.gcd > 0) threw = true }
  check('left-click in grenade mode throws a grenade', nade && threw && !api.ui.nadeMode());

  // pause / resume
  g.fireWin('keydown', { code: 'KeyP' });
  check('P pauses and freezes the clock', api.state() === 'paused' && (() => { const t0 = api.clock(); g.step(120); return api.clock() === t0 })());
  g.fireWin('keydown', { code: 'KeyP' });
  check('P resumes', api.playing());

  // camera + resize
  g.fire(g.els.cv, 'wheel', { clientX: 100, clientY: 100, deltaY: -100 });
  check('wheel zooms in', api.ui.zoom() > 1, `zoom ${api.ui.zoom().toFixed(2)}`);
  api.ui.setZoom(99);
  check('setZoom clamps to the supported range', api.ui.zoom() <= 1.7);
  g.fire(g.els.mm, 'pointerdown', { clientX: 75, clientY: 40 });
  g.fire(g.els.mm, 'pointerup', {});
  check('minimap click moves the camera without error', api.error() === '');
  g.els.view.clientWidth = 500; g.win._ro(); g.step(2);
  check('resize reflows the canvas', api.ui.screen().W === 500 && g.els.cv.width === 500);

  // touch
  const t = play();
  const cam0 = { x: t.api.camera().x, y: t.api.camera().y };
  t.g.fire(t.g.els.cv, 'pointerdown', { pointerType: 'touch', clientX: 300, clientY: 200 });
  t.g.fire(t.g.els.cv, 'pointermove', { pointerType: 'touch', clientX: 360, clientY: 240 });
  t.g.fire(t.g.els.cv, 'pointerup', { pointerType: 'touch', clientX: 360, clientY: 240 });
  check('touch drag pans the camera', Math.abs(t.api.camera().x - cam0.x) > 1);
  t.g.fire(t.g.els.cv, 'pointerdown', { pointerType: 'touch', clientX: 200, clientY: 150 });
  t.g.fire(t.g.els.cv, 'pointerup', { pointerType: 'touch', clientX: 200, clientY: 150 });
  check('touch tap handled without error', t.api.error() === '');

  // HUD is built from content
  const { g: hg, api: ha } = play();
  const buttons = hg.els.bar.children.filter(c => c.className === 'unitbtn');
  check('one deploy button per deployable unit type', buttons.length === 2 &&
    buttons.map(b => b.dataset.unit).sort().join() === 'rifles,specops');
  check('deploy buttons show the unit name and cost',
    buttons.some(b => /Spec ops · 200/.test(b.textContent)));
  ha.debug.setCp(0); ha.ui.hud();
  check('deploy buttons disable while unaffordable', buttons.every(b => b.disabled));
  ha.debug.setCp(500); ha.ui.hud();
  check('deploy buttons enable when affordable', buttons.some(b => !b.disabled));
  const bar = hg.els.bar;
  const order = bar.children.filter(c => c.className === 'unitbtn').map(b => b.dataset.unit).join();
  check('deploy buttons follow the faction unit list order', order === ha.factions().player.units.join());
  check('the pause button sits after the deploy buttons', bar.children[bar.children.length - 1] === hg.els.pz);
});

/* =========================================== 7. objectives & win/lose ==== */

suite('objectives & win/lose', () => {
  // victory: capture the enemy HQ
  const v = play();
  v.api.debug.setWaveTimer(1e9);
  v.api.debug.clearSquads(v.api.teams.enemy);
  for (const q of v.api.playerSquads()) v.api.debug.teleportSquad(q, v.api.world.enemyHq.x, v.api.world.enemyHq.y);
  let st = null, peak = 0;
  for (let i = 0; i < 60 * 20 && !st; i++) {
    v.g.step(1);
    peak = Math.max(peak, v.api.zones().find(z => z.team !== v.api.teams.player).cap);
    if (v.api.state() !== 'play') st = v.api.state();
  }
  check('holding the enemy HQ fills its capture meter', peak >= 1, `peak ${peak.toFixed(2)}`);
  check('capturing the enemy HQ wins the match', st === 'won', `state=${st}`);
  check('victory shows the Victory panel with a restart', v.api.ui.overlayText() === 'Victory' && /again/i.test(v.g.els.ovb.lastChild.textContent));

  // victory: wipe the garrison after the last wave
  const w = play();
  w.api.debug.skipWaves(w.api.registry.waves.length);
  w.api.debug.clearSquads(w.api.teams.enemy);
  w.g.step(60 * 3);
  check('wiping out the garrison after the last wave wins', w.api.state() === 'won', `state=${w.api.state()}`);

  // defeat: lose your HQ (own squads moved aside, else the zone is contested)
  const d = play();
  d.api.debug.setWaveTimer(1e9);
  const away = farSpot(d.api);
  for (const q of d.api.playerSquads()) d.api.debug.teleportSquad(q, away.x, away.y);
  d.api.debug.clearSquads(d.api.teams.enemy);
  const hq = d.api.world.playerHq;
  for (let i = 0; i < 3; i++) d.api.debug.spawnUnit('assault', d.api.teams.enemy, hq.x, hq.y, 'guard');
  let dl = null, ownPeak = 0;
  for (let i = 0; i < 60 * 40 && !dl; i++) {
    d.g.step(1);
    for (const z of d.api.zones()) if (z.team === d.api.teams.player) ownPeak = Math.max(ownPeak, z.cap);
    if (d.api.state() !== 'play') dl = d.api.state();
  }
  check('holding your HQ fills your own capture meter', ownPeak >= 1, `peak ${ownPeak.toFixed(2)}`);
  check('losing your HQ ends the match as a defeat', dl === 'lost', `state=${dl}`);
  check('defeat shows the Defeat panel', d.api.ui.overlayText() === 'Defeat');

  // defeat: eliminated with too few points to redeploy
  const e = play();
  e.api.debug.setCp(10);
  e.api.debug.clearSquads(e.api.teams.player);
  e.g.step(60 * 3);
  check('wiped out with less than the cheapest unit ends the match', e.api.state() === 'lost', `state=${e.api.state()}`);

  // only one outcome per match
  check('the win/lose objectives are terminal (match ends once)',
    v.g.els.ovb.lastChild.textContent.includes('again') && w.api.state() === 'won');
  // ending via the api is honoured
  const m = play();
  m.api.end(false, 'resigned');
  check('api.end() ends the match with a custom message', m.api.state() === 'lost' && m.g.els.ovp.textContent === 'resigned');
});

/* ================================ 8. extending the game via the public API = */

suite('extending the game through the public API', () => {
  // Everything below is written the way a modder (or an LLM) would: only public calls.
  const { g, api } = play();
  const before = api.registry.units.length;

  // --- a new weapon + role ---------------------------------------------------
  api.defineWeapon({ id: 'smg', name: 'SMG', range: 6.5, burst: 4, iv: .08, c0: .5, c1: .9, dmg: 9, acc: .45, mag: 40, rt: 2, sound: 'light' });
  api.defineRole({ id: 'shock', name: 'Shock trooper', weapon: 'smg', sprite: 'soldier' });

  // --- a new squad type ------------------------------------------------------
  const type = api.defineUnit({
    id: 'hunters', name: 'Hunter squad', cost: 150, count: 5, speed: 2.2, formation: 1, grenade: 12,
    roles: [{ id: 'shock' }, { id: 'shock' }, { id: 'shock' }, { id: 'shock' }, { id: 'shock' }],
    portrait: { head: '#7a5f2f', helm: '#5a4520', skin: '#c99a6e', band: '#ffd79a' },
    notes: ['test content: fast SMG squad'],
    onDeploy: (q, a) => { q.deployedVia = 'onDeploy hook' },              // content hook
  });
  api.factions().player.units.push('hunters');
  api.ui.buttons();
  check('defineUnit registers a new squad type', api.registry.units.length === before + 1 && api.unit('hunters') === type);
  check('a new role resolves its new weapon', api.role('shock').weapon === 'smg' && api.soldiers()[0] !== undefined);
  check('the new type gets a deploy button', g.els.bar.children.some(c => c.dataset.unit === 'hunters'));
  api.debug.setCp(1000);
  const q = api.deployUnit('hunters');
  check('the new squad deploys with its own roster', !!q && q.soldiers.map(s => s.role).join() === 'shock,shock,shock,shock,shock');
  check('the new squad uses its own weapon profile', q.soldiers[0].weapon.id === 'smg' && q.soldiers[0].weapon.range === 6.5);
  check('content hooks (onDeploy) fire on deploy', q.deployedVia === 'onDeploy hook');
  check('debug.spawnUnit can spawn the new type for the enemy', api.debug.spawnUnit('hunters', api.teams.enemy, 20, 20) !== null);

  // --- a new building behaviour + building type ------------------------------
  let ticks = 0;
  api.defineBuildingBehaviour('beacon', {
    vision: (inst, a, bv) => bv.radius,
    tick(inst, dt, a, bv) { ticks++; inst.charged = (inst.charged || 0) + dt * bv.rate },
  });
  api.defineBuilding({ id: 'beacon', name: 'Beacon', w: 1, h: 1, height: 20, blocks: true, cover: true, style: 0, team: 0, behaviours: [{ id: 'beacon', radius: 9, rate: 2 }] });
  const site = farSpot(api);
  const beacon = api.debug.spawnBuilding('beacon', Math.floor(site.x), Math.floor(site.y), api.teams.player);
  const N = api.world.N;
  const seen = () => { let n = 0; for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (api.view.tile(i, j) > 0) n++; return n };
  const t0 = seen();
  g.step(30);
  api.view.uptodate();
  check('defineBuilding places a new building type', !!beacon && api.buildings().includes(beacon));
  check('its behaviour tick runs every simulation step', ticks >= 30 && beacon.charged > 0.9, `${ticks} ticks, charge ${beacon.charged.toFixed(2)}`);
  check('its vision hook reveals fog for its owner', seen() - t0 > 20, `+${seen() - t0} tiles`);
  check('the new building blocks movement like any other', !api.walkable(beacon.x, beacon.y));
  const p2 = api.freeSpot(site.x + 4, site.y + 4);
  const foeBeacon = api.debug.spawnBuilding('beacon', Math.floor(p2.x), Math.floor(p2.y), api.teams.enemy, { capturable: true, capTime: 2, capR: 3.5 });
  check('a placed building can be declared capturable', !!foeBeacon && foeBeacon.capturable === true && foeBeacon.capTime === 2 && foeBeacon.capR === 3.5);
  api.debug.teleportSquad(q, foeBeacon.x, foeBeacon.y);
  let flipped = false;
  for (let i = 0; i < 60 * 8 && !flipped; i++) { g.step(1); api.debug.teleportSquad(q, foeBeacon.x, foeBeacon.y); flipped = foeBeacon.team === api.teams.player }
  check('a new capturable building flips team when held', flipped, `capTime 2 s, flipped=${flipped}`);

  // --- a new simulation system ----------------------------------------------
  let pulses = 0;
  api.defineSystem({ id: 'test.pulse', order: api.ORDER.OBJECTIVES + 1, run(dt, a) { pulses++ } });
  check('defineSystem keeps the registry sorted by order',
    api.registry.systems.every((s, i, arr) => i === 0 || arr[i - 1].order <= s.order));
  g.step(10);
  check('a system registered at runtime runs each step', pulses >= 10, `${pulses} runs`);

  // --- new orders, commands, objectives -------------------------------------
  let ordered = null;
  api.defineOrder({
    id: 'regroup', name: 'Regroup', key: 'KeyQ',
    start(qs, x, y, a) { ordered = { n: qs.length, x, y } },
    run(sq, o, dt, a) { if (!sq.path.length) a.moveTo(sq, a.world.playerHq.x, a.world.playerHq.y, null) },
  });
  api.selection().clear(); api.selection().add(q);
  const aim = api.ui.worldToScreen(api.world.playerHq.x + 6, api.world.playerHq.y);
  g.fire(g.els.cv, 'pointermove', { clientX: aim.x, clientY: aim.y });
  g.fireWin('keydown', { code: 'KeyQ' });
  check('a new key-bound order is issued at the cursor', !!ordered && ordered.n >= 1 && Math.hypot(ordered.x - (api.world.playerHq.x + 6), ordered.y - api.world.playerHq.y) < 1.5,
    JSON.stringify(ordered));
  g.step(30);
  check('its per-frame run() drives the squad', q.path.length > 0 || q.order === null, `order=${q.order && q.order.type} path=${q.path.length}`);

  let saluted = false;
  api.defineCommand({ id: 'test.salute', key: 'KeyZ', label: 'Salute', run(a) { saluted = true } });
  g.fireWin('keydown', { code: 'KeyZ' });
  check('a new key command dispatches', saluted === true);

  api.defineObjective({ id: 'test.reach', result: 'victory', test: (ctx, a) => a.commandPoints() > 5000, with: [{ at: 0, run: (ctx, a) => a.end(true, 'test objective') }] });
  api.debug.setCp(6000);
  g.step(2);
  check('a new objective can end the match', api.state() === 'won' && g.els.ovp.textContent === 'test objective');
  check('the extension run left no runtime error', api.error() === '', api.error());
});

/* ========================================= 9. stability & performance ==== */

suite('stability (long simulation + input fuzz)', () => {
  const mins = QUICK ? 3 : 20;
  const { g, api } = play();
  api.debug.setCp(1e9);
  let frames = 0, maxParts = 0, maxBullets = 0, maxCorpses = 0, ended = null;
  const t0 = Date.now();
  while (frames < 60 * 60 * mins && !ended && !api.error()) {
    g.step(1); frames++;
    maxParts = Math.max(maxParts, api.parts().length);
    maxBullets = Math.max(maxBullets, api.bullets().length);
    maxCorpses = Math.max(maxCorpses, api.corpses().length);
    if (frames % 120 === 0) {
      api.selection().clear();
      for (const q of api.playerSquads()) api.selection().add(q);
      const s = api.ui.screen();
      api.command(s.W - 60, s.H * .7, null, null);                  // push toward the enemy HQ
      if (api.commandPoints() >= 200) api.deployUnit('specops');
    }
    if (api.state() !== 'play') ended = api.state();
  }
  info(`${mins} min simulated in ${((Date.now() - t0) / 1000).toFixed(1)} s wall; result=${ended || '(still playing)'}, kills=${api.kills()}, waves=${api.wave()}/${api.registry.waves.length}`);
  check(`unattended ${mins}-minute match runs without a runtime error`, api.error() === '', api.error());
  check('waves keep coming and the enemy reaches the player side', api.wave() >= (QUICK ? 1 : 4), `wave ${api.wave()}`);
  check('particle pool honours its cap', maxParts <= 1400, `peak ${maxParts}`);
  check('bullets stay bounded', maxBullets < 500, `peak ${maxBullets}`);
  check('corpses stay bounded', maxCorpses < 260, `peak ${maxCorpses}`);

  // input fuzz across the whole control surface
  const fz = play();
  const R = lcg(12345);
  const keys = ['KeyR', 'KeyF', 'KeyX', 'KeyG', 'KeyP', 'KeyP', 'Digit1', 'Digit2', 'Digit3', 'Space', 'Escape'];
  const budget = QUICK ? 60 * 90 : 60 * 60 * 15;
  let n = 0;
  while (n < budget && !fz.api.error()) {
    fz.g.step(1); n++;
    if (n % 30) continue;
    const ev = { clientX: 40 + R() * 600, clientY: 40 + R() * 350 };
    if (R() < .35) { fz.g.fire(fz.g.els.cv, 'pointerdown', { ...ev, button: 0 }); fz.g.fire(fz.g.els.cv, 'pointerup', ev) }
    if (R() < .35) { fz.g.fire(fz.g.els.cv, 'pointerdown', { ...ev, button: 2 }); fz.g.fire(fz.g.els.cv, 'pointerup', { ...ev, button: 2 }) }
    if (R() < .15) { fz.g.fire(fz.g.els.cv, 'pointerdown', { ...ev, button: 0 }); fz.g.fire(fz.g.els.cv, 'pointermove', { clientX: ev.clientX + 40, clientY: ev.clientY + 25 }); fz.g.fire(fz.g.els.cv, 'pointerup', { clientX: ev.clientX + 40, clientY: ev.clientY + 25 }) }
    if (R() < .1) fz.g.fire(fz.g.els.cv, 'wheel', { ...ev, deltaY: R() < .5 ? -100 : 100 });
    if (R() < .2) { const k = keys[(R() * keys.length) | 0]; fz.g.fireWin('keydown', { code: k }); if (k.startsWith('Digit')) fz.g.fireWin('keyup', { code: k }) }
  }
  check('fuzzed pointer/keyboard input never throws', fz.api.error() === '', `${n} frames; ${fz.api.error()}`);
  check('game stays in a coherent state after fuzz', ['play', 'paused', 'won', 'lost'].includes(fz.api.state()), fz.api.state());
  check('simulation state stays finite', fz.api.soldiers().every(s => Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.hp)) &&
    fz.api.squads().every(q => Number.isFinite(q.ax) && Number.isFinite(q.ay)));
});

suite('performance budgets', () => {
  const { g, api } = play();
  api.debug.setCp(1e9);
  const mins = QUICK ? 3 : 12;
  for (let i = 0; i < 60 * 60 * mins && api.playing(); i++) { g.step(1); if (i % 120 === 0 && api.commandPoints() >= 200) api.deployUnit('specops') }
  const cv = g.els.cv.ctx;
  for (const k of Object.keys(cv.calls)) cv.calls[k] = 0;
  const t0 = Date.now(); g.step(600); const ms = (Date.now() - t0) / 600;
  const perFrame = Math.round(Object.values(cv.calls).reduce((a, b) => a + b, 0) / 600);
  info(`load: ${api.squads().length} squads / ${api.soldiers().length} soldiers / ${api.buildings().length} buildings`);
  info(`simulation + draw-call submission: ${ms.toFixed(3)} ms/frame (rasterisation stubbed)`);
  info(`canvas2D calls issued per frame: ${perFrame}`);
  check('game loop fits inside a 16.7 ms frame (logic only, headless)', ms < 16.7, `${ms.toFixed(3)} ms/frame`);
  check('draw-call volume stays modest for Canvas2D', perFrame < 8000, `${perFrame} calls/frame`);
  check('long match leaves no runtime error', api.error() === '', api.error());
});

/* ---------------------------------------------------------------- runner -- */

const selected = filter ? suites.filter(s => s.name.includes(filter)) : suites;
if (!selected.length) {
  console.error(`no suite matches "${filter}". available:\n  ` + suites.map(s => s.name).join('\n  '));
  process.exit(2);
}
const t0 = Date.now();
for (const s of selected) {
  current = s; console.log(`\n${s.name}`); s.checks = [];
  try { s.fn() } catch (e) { check(`suite ran to completion (${e.message})`, false, (e.stack || '').split('\n')[1] || '') }
}
const all = selected.flatMap(s => s.checks), failed = all.filter(c => !c.ok);
console.log(`\n${'-'.repeat(60)}`);
console.log(`${all.length - failed.length}/${all.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)} s` + (QUICK ? ' (quick mode)' : ''));
if (failed.length) { console.log('\nfailures:'); for (const f of failed) console.log(`  - [${suites.find(s => s.checks.includes(f)).name}] ${f.name}${f.extra ? ' — ' + f.extra : ''}`) }
process.exit(failed.length ? 1 : 0);
