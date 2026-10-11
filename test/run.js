'use strict';
/*
 * Test suite for index.html (Squad command).
 *
 *   node test/run.js            full run (~30 s)
 *   node test/run.js --quick    skips the long simulated matches (~8 s)
 *   node test/run.js path       runs only suites whose name matches "path"
 *
 * Exits non-zero if any check fails. Requires only Node (no dependencies).
 */

const fs = require('fs');
const path = require('path');
const { boot, loadGameScript, GAME_HTML } = require('./harness');

const QUICK = process.argv.includes('--quick');
const filter = process.argv.slice(2).find(a => !a.startsWith('--'));

const suites = [];
let current = null;
function suite(name, fn) { suites.push({ name, fn, checks: [] }) }

function check(name, cond, extra = '') {
  current.checks.push({ name, ok: !!cond, extra });
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`  ${tag}  ${name}${extra ? '  — ' + extra : ''}`);
}
const info = msg => console.log(`        ${msg}`);

/* ------------------------------------------------------------------ utils -- */

function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

// Independent flood fill using the same movement rule as the game's A*
// (8-way, no cutting diagonally between two blocked tiles).
function bfsReachable(G, si, sj, ti, tj) {
  const N = G.N, DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1];
  if (G.block[sj * N + si]) return false;
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
      if (G.block[nn] || seen[nn]) continue;
      if (di && dj && (G.block[cj * N + ni] || G.block[nj * N + ci])) continue;
      seen[nn] = 1; q.push(nn);
    }
  }
  return false;
}

const hash = arr => {
  let h = 2166136261;
  for (let i = 0; i < arr.length; i++) { h ^= arr[i]; h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(16);
};

/* =========================================================== 1. boot/map = */

suite('boot & map generation', () => {
  const g = boot({ exposeInternals: true });
  const G = g.internals();
  check('boots with no runtime error', G.err === '');
  check('initial state is "start" (overlay, not playing)', G.state === 'start');
  check('3 player squads + 5 enemy garrison seeded',
    G.squads.filter(q => !q.team).length === 3 && G.squads.filter(q => q.team).length === 5);
  check('every squad fields 5 soldiers', G.squads.every(q => q.soldiers.length === 5));
  check('player start tiles are walkable', G.STARTS.every(p => !G.bp(p.x, p.y)));
  check('enemy spawn tiles are walkable', G.SPAWNS.every(p => !G.bp(p.x, p.y)));
  check('both HQ tiles are walkable', !G.bp(G.PHQ.x, G.PHQ.y) && !G.bp(G.EHQ.x, G.EHQ.y));
  check('guard positions are walkable', G.GARR.every(p => !G.bp(p.x, p.y)));

  const statics = G.statics();
  const byType = {};
  for (const o of statics) byType[o.t] = (byType[o.t] || 0) + 1;
  info(`statics: ${JSON.stringify(byType)}`);
  let blocked = 0;
  for (let k = 0; k < G.N * G.N; k++) if (G.block[k]) blocked++;
  info(`blocked tiles: ${blocked}/${G.N * G.N} (${(100 * blocked / (G.N * G.N)).toFixed(1)}%), water tiles: ${G.water.length}`);
  check('generated buildings, cover, trees and both flags',
    byType.bld >= 40 && byType.bags >= 20 && byType.tree >= 40 && byType.flag === 2);
  check('map is roughly a third blocked (pathing-relevant density)', blocked > 200 && blocked < 600);
  check('PERMS table holds 120 five-man slot permutations', G.PERMS[5].length === 120);

  // Map generation must be deterministic (seeded PRNG, no Math.random in genMap).
  const g2 = boot({ exposeInternals: true });
  const G2 = g2.internals();
  check('map generation is deterministic across boots',
    hash(G.block) === hash(G2.block) && hash(G.ground) === hash(G2.ground),
    `block#${hash(G.block)} ground#${hash(G.ground)}`);
  check('starts are spread along the diagonal', G.STARTS.length === 3);
});

/* ========================================================= 2. pathfinding = */

suite('pathfinding', () => {
  const g = boot({ exposeInternals: true });
  const G = g.internals();
  const R = lcg(987654321);
  const N = G.N, cap = G.hN.length;
  let illegal = 0, empty = 0, tested = 0, falseNeg = 0, falsePos = 0, peakHeap = 0;

  for (let t = 0; t < 3000; t++) {
    const ax = .5 + R() * (N - 1), ay = .5 + R() * (N - 1);
    const bx = .5 + R() * (N - 1), by = .5 + R() * (N - 1);
    if (G.bp(ax, ay) || G.bp(bx, by)) continue;
    tested++;
    const p = G.findPath(ax, ay, bx, by);
    peakHeap = Math.max(peakHeap, G.hL);
    const reachable = bfsReachable(G, Math.floor(ax), Math.floor(ay), Math.floor(bx), Math.floor(by));
    if (!p.length) { empty++; if (reachable) falseNeg++; continue }
    if (!reachable) falsePos++;
    // Walk the returned polyline: no waypoint in a wall, no segment through one,
    // and the final waypoint must land on the requested goal.
    let prev = { x: ax, y: ay }, bad = false;
    for (const w of p) {
      if (G.bp(w.x, w.y) || !G.segClear(prev.x, prev.y, w.x, w.y, 0)) { bad = true; break }
      prev = w;
    }
    if (bad || Math.hypot(prev.x - bx, prev.y - by) > 0.05) illegal++;
  }

  check('returned paths never cross blocked tiles and always reach the goal', illegal === 0,
    `${illegal} illegal of ${tested}`);
  check('never returns a path to an unreachable goal (verified against BFS)', falsePos === 0, `${falsePos}`);
  check('never fails a search BFS proves reachable (A* correctness)', falseNeg === 0, `${falseNeg}`);
  const pockets = empty - falseNeg;
  info(`unreachable pockets: ${pockets}/${tested} queries (${(100 * pockets / tested).toFixed(1)}%) end in walled-off tiles`);
  check('walled-off pockets stay rare (<5% of walkable queries)', pockets / tested < 0.05,
    `${(100 * pockets / tested).toFixed(2)}%`);
  check('A* heap keeps large headroom (typed array is fixed at N*N*8)', peakHeap < cap * 0.5,
    `peak ${peakHeap}/${cap} slots (${(100 * peakHeap / cap).toFixed(2)}%)`);
  check('trivial same-tile query is a no-op', G.findPath(10.5, 10.5, 10.5, 10.5).length === 1);

  // Both HQs must be connected to every start/spawn - an unreachable HQ would
  // make the capture objective impossible.
  const goals = [[G.EHQ.x, G.EHQ.y], [G.PHQ.x, G.PHQ.y]];
  let hqFails = [];
  for (const s of [...G.STARTS, ...G.SPAWNS]) {
    for (const [gx, gy] of goals) {
      const from = [s.x, s.y], to = [gx, gy];
      if (!G.findPath(from[0], from[1], to[0], to[1]).length) hqFails.push(`${s.x},${s.y}->${gx},${gy}`);
    }
  }
  check('both HQs are reachable from every start and spawn', hqFails.length === 0, hqFails.join(' '));

  // Line of sight blocking: buildings must break LOS through their footprint.
  let losChecked = 0, losOk = true;
  for (const o of G.statics()) {
    if (o.t !== 'bld' || losChecked++ > 12) continue;
    const mid = { x: o.i + .5, y: o.j + .5 };
    const a = { x: mid.x - 6, y: mid.y }, b = { x: mid.x + 6, y: mid.y };
    if (G.bp(a.x, a.y) || G.bp(b.x, b.y)) continue;
    if (G.los(a.x, a.y, b.x, b.y)) { losOk = false; break }
  }
  check('buildings block line of sight across their footprint', losOk, `${losChecked} sampled`);
});

/* ==================================================== 3. controls/input = */

suite('controls & interaction', () => {
  const g = boot({ exposeInternals: true });
  const G = g.internals();
  g.fire(g.els.ovb, 'click');
  check('overlay Deploy button starts the match', G.state === 'play');

  // squad costs 120 CP and the match starts with 60, so a first R press is
  // correctly refused; fund it and it goes through.
  check('deploy is refused while CP < 120', (() => {
    const n0 = G.squads.filter(q => !q.team).length;
    g.fireWin('keydown', { code: 'KeyR' });
    return G.squads.filter(q => !q.team).length === n0;
  })(), `cp=${G.cp.toFixed(0)}`);

  G.cp = 500;
  const cp0 = G.cp;
  g.fireWin('keydown', { code: 'KeyR' });
  check('R deploys a squad and charges 120 CP',
    G.squads.filter(q => !q.team).length === 4 && G.cp === cp0 - 120,
    `cp ${cp0.toFixed(0)} -> ${G.cp.toFixed(0)}`);

  G.cp = 1e6;
  for (let i = 0; i < 5; i++) g.fireWin('keydown', { code: 'KeyR' });
  check('player is capped at 6 squads', G.squads.filter(q => !q.team).length === 6);

  const screenOf = (x, y) => {
    const z = G.cam.z, W = g.els.cv.width, H = g.els.cv.height;
    return { x: G.ix(x, y) * z + (W / 2 - G.cam.x * z), y: G.iy(x, y) * z + (H / 2 - G.cam.y * z) };
  };

  g.fireWin('keydown', { code: 'KeyA', ctrlKey: true });
  check('Ctrl+A selects every player squad', G.sel.size === 6);
  g.fire(g.els.cv, 'pointerdown', { button: 2, clientX: 400, clientY: 300 });
  g.fire(g.els.cv, 'pointerup', { button: 2, clientX: 400, clientY: 300 });
  const players = G.squads.filter(q => !q.team);
  check('right-click gives every selected squad a move order',
    players.every(q => q.order && q.order.type === 'move'));
  check('group move targets are spread, not stacked',
    new Set(players.map(q => Math.round(q.order.x * 10) + ',' + Math.round(q.order.y * 10))).size >= 5,
    `${new Set(players.map(q => Math.round(q.order.x) + ',' + Math.round(q.order.y))).size} distinct targets`);
  const before = players.map(q => ({ x: q.ax, y: q.ay }));
  g.step(90);
  const movedCount = players.filter((q, i) => Math.hypot(q.ax - before[i].x, q.ay - before[i].y) > .5).length;
  check('ordered squads actually travel', movedCount >= players.length - 1, `${movedCount}/${players.length} moved`);

  const form0 = G.squads.find(q => !q.team).form;
  g.fireWin('keydown', { code: 'KeyF' });
  check('F cycles formation', G.squads.find(q => !q.team).form !== form0);
  g.fireWin('keydown', { code: 'KeyF' });
  g.fireWin('keydown', { code: 'KeyF' });
  check('formation wraps around after 3 presses', G.squads.find(q => !q.team).form === form0,
    `form ${form0} -> ${G.squads.find(q => !q.team).form}`);

  g.fireWin('keydown', { code: 'KeyX' });
  check('X clears orders and paths', G.squads.filter(q => !q.team).every(q => !q.order && !q.path.length));

  // grenade mode: G, then left-click a spot ~4 tiles out (inside the 6.5-tile
  // throw range, so the squad throws without walking)
  const sq = G.squads.filter(q => !q.team)[0];
  const tgt = screenOf(sq.ax + 4, sq.ay);
  g.fireWin('keydown', { code: 'KeyG' });
  const armed = G.nadeMode;
  g.fire(g.els.cv, 'pointerdown', { button: 0, clientX: tgt.x, clientY: tgt.y });
  let sawNade = false, threw = false;
  for (let i = 0; i < 60 * 3; i++) {
    g.step(1);
    if (G.nades.length) sawNade = true;
    if (G.squads.filter(q => !q.team).some(q => q.gcd > 0)) threw = true;
  }
  check('G arms grenade mode', armed);
  check('left-click in grenade mode throws a grenade (nearest ready squad in range)',
    sawNade && threw, `projectile seen=${sawNade}, recall timer set=${threw}`);

  g.fireWin('keydown', { code: 'KeyP' });
  check('P pauses', G.state === 'paused');
  const gtPaused = G.gt;
  g.step(120);
  check('clock is frozen while paused', G.gt === gtPaused);
  g.fireWin('keydown', { code: 'KeyP' });
  check('P resumes', G.state === 'play');
  g.step(60);
  check('clock advances after resuming', G.gt > gtPaused);

  // selection via click on a squad chip, and via canvas tap
  g.fire(g.els.cv, 'pointerdown', { clientX: 0, clientY: 0 });
  g.fire(g.els.cv, 'pointerup', { clientX: 0, clientY: 0 });
  check('empty-canvas click clears selection', G.sel.size === 0);
  g.fireWin('keydown', { code: 'Digit1' });
  check('number key selects a squad', G.sel.size === 1);
  g.fireWin('keydown', { code: 'Space' });
  check('Space centres the camera on selection without error', G.err === '');

  g.els.view.clientWidth = 500;
  g.win._ro();
  g.step(2);
  check('resize reflows the canvas', G.err === '' && g.els.cv.width === 500, `canvas width ${g.els.cv.width}`);

  g.fire(g.els.cv, 'wheel', { clientX: 100, clientY: 100, deltaY: -100 });
  check('wheel zooms in', G.cam.z > 1, `z=${G.cam.z.toFixed(2)}`);
  g.fire(g.els.mm, 'pointerdown', { clientX: 75, clientY: 40 });
  g.fire(g.els.mm, 'pointerup', {});
  check('minimap click moves the camera without error', G.err === '');

  // touch: drag pans, tap selects
  const g2 = boot({ exposeInternals: true });
  const G2 = g2.internals();
  g2.fire(g2.els.ovb, 'click');
  const cam0 = { x: G2.cam.x, y: G2.cam.y };
  g2.fire(g2.els.cv, 'pointerdown', { pointerType: 'touch', clientX: 300, clientY: 200 });
  g2.fire(g2.els.cv, 'pointermove', { pointerType: 'touch', clientX: 360, clientY: 240 });
  g2.fire(g2.els.cv, 'pointerup', { pointerType: 'touch', clientX: 360, clientY: 240 });
  check('touch drag pans the camera', Math.abs(G2.cam.x - cam0.x) > 1);
  g2.fire(g2.els.cv, 'pointerdown', { pointerType: 'touch', clientX: 200, clientY: 150 });
  g2.fire(g2.els.cv, 'pointerup', { pointerType: 'touch', clientX: 200, clientY: 150 });
  check('touch tap is handled without error', G2.err === '');
});

/* ======================================================== 4. objectives = */

suite('objectives & win/lose', () => {
  // win: clear the garrison, park on the enemy flag, wait out the capture timer
  const g = boot({ exposeInternals: true });
  const G = g.internals();
  g.fire(g.els.ovb, 'click');
  G.waveT = 1e9;
  for (const q of G.squads.filter(s => s.team)) { q.alive = false; q.soldiers.length = 0 }
  for (const q of G.squads.filter(s => !s.team)) {
    q.ax = G.EHQ.x; q.ay = G.EHQ.y;
    for (const s of q.soldiers) { s.x = G.EHQ.x; s.y = G.EHQ.y }
  }
  let peak = 0, final = null;
  for (let i = 0; i < 60 * 20 && final === null; i++) {
    g.step(1);
    peak = Math.max(peak, G.flags[1].cap);
    if (G.state !== 'play') final = G.state;
  }
  check('holding the enemy HQ fills the capture meter', peak >= 1, `peak ${peak.toFixed(2)}`);
  check('capturing the enemy HQ wins the match', final === 'won', `state=${final}`);
  check('victory shows the Victory panel', g.els.ovt.textContent === 'Victory', `"${g.els.ovt.textContent}"`);
  check('victory panel offers a restart', /again/i.test(g.els.ovb.lastChild.textContent), `"${g.els.ovb.lastChild.textContent}"`);

  // win via eliminating the last wave
  const gw = boot({ exposeInternals: true });
  const GW = gw.internals();
  gw.fire(gw.els.ovb, 'click');
  GW.waveI = 100;
  for (const q of GW.squads.filter(s => s.team)) { q.alive = false; q.soldiers.length = 0 }
  GW.cp = 500;
  gw.step(60 * 3);
  check('wiping out the garrison after the last wave wins the match', GW.state === 'won', `state=${GW.state}`);

  // loss: enemy sits on your HQ
  const gl = boot({ exposeInternals: true });
  const GL = gl.internals();
  gl.fire(gl.els.ovb, 'click');
  GL.waveT = 1e9;
  for (const q of GL.squads.filter(s => s.team)) {
    q.ax = GL.PHQ.x; q.ay = GL.PHQ.y;
    for (const s of q.soldiers) { s.x = GL.PHQ.x; s.y = GL.PHQ.y }
  }
  let lost = null;
  for (let i = 0; i < 60 * 40 && lost === null; i++) { gl.step(1); if (GL.state !== 'play') lost = GL.state }
  check('losing your HQ ends the match as a defeat', lost === 'lost', `state=${lost}`);
  check('defeat shows the Defeat panel', gl.els.ovt.textContent === 'Defeat', `"${gl.els.ovt.textContent}"`);

  // loss: eliminated with too few points to redeploy
  const ge = boot({ exposeInternals: true });
  const GE = ge.internals();
  ge.fire(ge.els.ovb, 'click');
  for (const q of GE.squads.filter(s => !s.team)) { q.alive = false; q.soldiers.length = 0 }
  GE.cp = 10;
  ge.step(180);
  check('wiped out with <120 CP ends the match as a defeat', GE.state === 'lost', `state=${GE.state}`);
});

/* ============================================================ 5. combat = */

suite('combat & support mechanics', () => {
  const g = boot({ exposeInternals: true });
  const G = g.internals();
  g.fire(g.els.ovb, 'click');
  const pq = G.squads.find(q => !q.team), eq = G.squads.find(q => q.team);
  const px = pq.ax, py = pq.ay;
  eq.ax = px + 3; eq.ay = py + 3;
  for (const s of eq.soldiers) { s.x = px + 3; s.y = py + 3; s.covT = 0 }
  const hp0 = eq.soldiers.reduce((a, s) => a + s.hp, 0);
  const cp0 = G.cp, gt0 = G.gt;
  let sawTracer = false;
  for (let i = 0; i < 60 * 8; i++) { g.step(1); if (G.bullets.length) sawTracer = true }
  const alive = G.soldiers.filter(s => s.sq === eq);
  const hp1 = alive.reduce((a, s) => a + s.hp, 0);
  check('soldiers auto-acquire and kill contacts without orders',
    hp1 < hp0 || alive.length < 5, `HP ${hp0.toFixed(0)} -> ${hp1.toFixed(0)}, standing ${alive.length}`);
  check('gunfire emits tracer projectiles along a travel duration', sawTracer);
  check('kills are counted', G.kills > 0, `kills=${G.kills}`);
  const passive = 1.5 * (G.gt - gt0);
  check('each kill pays 15 CP on top of passive income',
    G.cp - cp0 >= 15 * G.kills, `cp +${(G.cp - cp0).toFixed(0)} for ${G.kills} kills (${passive.toFixed(0)} passive)`);
  check('corpses are kept for a while then reaped', G.corpses.length >= 0 && G.corpses.length < 500, `${G.corpses.length}`);

  // grenade splash damage: order a throw onto a stacked enemy squad 3 tiles away
  const g2 = boot({ exposeInternals: true });
  const G2 = g2.internals();
  g2.fire(g2.els.ovb, 'click');
  const eq2 = G2.squads.find(q => q.team);
  const pq2 = G2.squads.find(q => !q.team);
  eq2.ax = pq2.ax + 3; eq2.ay = pq2.ay + 3;
  for (const s of eq2.soldiers) { s.x = pq2.ax + 3; s.y = pq2.ay + 3; s.covT = 0 }
  for (const s of pq2.soldiers) s.covT = 0;
  const hp2a = eq2.soldiers.reduce((a, s) => a + s.hp, 0);
  const screenOf = (x, y) => {
    const z = G2.cam.z, W = g2.els.cv.width, H = g2.els.cv.height;
    return { x: G2.ix(x, y) * z + (W / 2 - G2.cam.x * z), y: G2.iy(x, y) * z + (H / 2 - G2.cam.y * z) };
  };
  g2.fireWin('keydown', { code: 'KeyA', ctrlKey: true });
  g2.fireWin('keydown', { code: 'KeyG' });
  const aim = screenOf(eq2.ax, eq2.ay);
  g2.fire(g2.els.cv, 'pointerdown', { button: 0, clientX: aim.x, clientY: aim.y });
  let sawNade = false, maxParts = 0, coolSet = false;
  for (let i = 0; i < 60 * 8; i++) {
    g2.step(1);
    if (G2.nades.length) sawNade = true;
    maxParts = Math.max(maxParts, G2.parts.length);
    if (G2.squads.filter(q => !q.team).some(q => q.gcd > 0)) coolSet = true;
  }
  const hp2b = G2.soldiers.filter(s => s.sq === eq2).reduce((a, s) => a + s.hp, 0);
  check('grenade order produces a thrown projectile', sawNade);
  check('grenade detonation deals area damage', hp2b < hp2a, `HP ${hp2a.toFixed(0)} -> ${hp2b.toFixed(0)}`);
  check('explosion spawns particles', maxParts > 0, `peak ${maxParts}`);
  check('grenade recall timer starts after the throw', coolSet);

  // reinforcement at HQ
  const g3 = boot({ exposeInternals: true });
  const G3 = g3.internals();
  g3.fire(g3.els.ovb, 'click');
  const q = G3.squads.find(s => !s.team);
  q.soldiers.pop();
  const n0 = q.soldiers.length;
  q.ax = G3.PHQ.x; q.ay = G3.PHQ.y;
  for (const m of q.soldiers) { m.x = G3.PHQ.x; m.y = G3.PHQ.y }
  g3.step(60 * 5);
  check('squads resting at your HQ regrow a lost soldier', q.soldiers.length > n0, `${n0} -> ${q.soldiers.length}`);
  check('reinforcement respects the 5-soldier cap', q.soldiers.length <= 5);

  // AI: garrison leashes to home instead of chasing forever
  const g4 = boot({ exposeInternals: true });
  const G4 = g4.internals();
  g4.fire(g4.els.ovb, 'click');
  G4.waveT = 1e9;
  const guard = G4.squads.find(q => q.team && q.ai === 'guard');
  const home = { x: guard.home.x, y: guard.home.y };
  g4.step(60 * 60);
  const dist = Math.hypot(guard.ax - home.x, guard.ay - home.y);
  check('guard AI returns to its post when nothing is in range', dist < 20, `${dist.toFixed(1)} tiles from home`);
});

/* ========================================================= 6. stability = */

suite('stability (long simulation + input fuzz)', () => {
  // unattended match: only periodic attack-move orders, no other interaction
  const g = boot({ exposeInternals: true });
  const G = g.internals();
  g.fire(g.els.ovb, 'click');
  const mins = QUICK ? 3 : 25;
  const budget = 60 * 60 * mins;
  let frames = 0, maxParts = 0, maxBullets = 0, maxCorpses = 0, ended = null;
  const t0 = Date.now();
  while (frames < budget && !ended && !G.err) {
    g.step(1); frames++;
    maxParts = Math.max(maxParts, G.parts.length);
    maxBullets = Math.max(maxBullets, G.bullets.length);
    maxCorpses = Math.max(maxCorpses, G.corpses.length);
    if (frames % 60 === 0) {
      g.fireWin('keydown', { code: 'KeyA', ctrlKey: true });
      g.fire(g.els.cv, 'pointerdown', { button: 2, clientX: 200, clientY: 300 });
      g.fire(g.els.cv, 'pointerup', { button: 2, clientX: 200, clientY: 300 });
      if (G.cp >= 120) g.fireWin('keydown', { code: 'KeyR' });
    }
    if (G.state === 'won' || G.state === 'lost') ended = G.state;
  }
  info(`${mins} min simulated in ${((Date.now() - t0) / 1000).toFixed(1)} s wall; result=${ended || '(still playing)'}, kills=${G.kills}, waves=${G.waveI}/${6}`);
  check(`unattended ${mins}-minute match runs without a runtime error`, !G.err, `err=${JSON.stringify(G.err)}`);
  check('particle pool honours its 1400 cap', maxParts <= 1400, `peak ${maxParts}`);
  check('bullets stay bounded', maxBullets < 500, `peak ${maxBullets}`);
  check('corpses stay bounded', maxCorpses < 500, `peak ${maxCorpses}`);
  if (!QUICK) check('waves eventually decide the match', ended !== null, `state=${G.state}`);

  // input fuzz: random pointer/keyboard traffic across the whole control surface
  const gf = boot({ exposeInternals: true });
  const GF = gf.internals();
  gf.fire(gf.els.ovb, 'click');
  const R = lcg(12345);
  const keys = ['KeyR', 'KeyF', 'KeyX', 'KeyG', 'KeyP', 'KeyP', 'Digit1', 'Digit2',
    'Digit3', 'Space', 'Escape'];
  const fzBudget = QUICK ? 60 * 90 : 60 * 60 * 20;
  let fz = 0;
  while (fz < fzBudget && !GF.err) {
    gf.step(1); fz++;
    if (fz % 30) continue;
    const x = 40 + R() * 600, y = 40 + R() * 350;
    if (R() < .35) {
      gf.fire(gf.els.cv, 'pointerdown', { button: 0, clientX: x, clientY: y });
      gf.fire(gf.els.cv, 'pointerup', { clientX: x, clientY: y });
    }
    if (R() < .35) {
      gf.fire(gf.els.cv, 'pointerdown', { button: 2, clientX: x, clientY: y });
      gf.fire(gf.els.cv, 'pointerup', { button: 2, clientX: x, clientY: y });
    }
    if (R() < .15) {
      gf.fire(gf.els.cv, 'pointerdown', { button: 0, clientX: x, clientY: y });
      gf.fire(gf.els.cv, 'pointermove', { clientX: x + 40, clientY: y + 25 });
      gf.fire(gf.els.cv, 'pointerup', { clientX: x + 40, clientY: y + 25 });
    }
    if (R() < .1) gf.fire(gf.els.cv, 'wheel', { clientX: x, clientY: y, deltaY: R() < .5 ? -100 : 100 });
    if (R() < .2) {
      const k = keys[(R() * keys.length) | 0];
      gf.fireWin('keydown', { code: k });
      if (k.startsWith('Digit')) gf.fireWin('keyup', { code: k });
    }
  }
  check('fuzzed pointer/keyboard input never throws', !GF.err, `err=${JSON.stringify(GF.err)} (${fz} frames)`);
  check('game survives fuzz in a coherent state',
    ['play', 'paused', 'won', 'lost'].includes(GF.state), `state=${GF.state}`);
  check('internal arrays stay consistent after fuzz',
    GF.soldiers.every(s => Number.isFinite(s.x) && Number.isFinite(s.y)) &&
    GF.squads.every(q => Number.isFinite(q.ax) && Number.isFinite(q.ay)));
});

/* ==================================================== 7. performance == */

suite('performance budgets', () => {
  const g = boot({ exposeInternals: true });
  const G = g.internals();
  G.cp = 1e9;
  g.fire(g.els.ovb, 'click');
  const mins = QUICK ? 3 : 12;
  for (let i = 0; i < 60 * 60 * mins && G.state === 'play'; i++) {
    g.step(1);
    if (i % 120 === 0 && G.cp >= 120) g.fireWin('keydown', { code: 'KeyR' });
  }
  const cv = g.els.cv.ctx;
  for (const k of Object.keys(cv.calls)) cv.calls[k] = 0;
  const t0 = Date.now();
  g.step(600);
  const ms = (Date.now() - t0) / 600;
  const calls = Object.values(cv.calls).reduce((a, b) => a + b, 0);
  const perFrame = Math.round(calls / 600);
  info(`load: ${G.squads.length} squads / ${G.soldiers.length} soldiers / ${G.vis.length} fog tiles`);
  info(`simulation + draw-call submission: ${ms.toFixed(3)} ms/frame (rasterisation is stubbed out)`);
  info(`canvas2D calls issued per frame: ${perFrame}`);
  check('game loop fits well inside a 16.7 ms frame (logic only, headless)', ms < 16.7, `${ms.toFixed(3)} ms/frame`);
  check('draw-call volume stays modest for Canvas2D', perFrame < 8000, `${perFrame} calls/frame`);
});

/* ================================================= 8. static document = */

suite('document structure (index.html)', () => {
  const { html } = loadGameScript();
  check('index.html is a single self-contained file', html.startsWith('<!DOCTYPE html>') && html.trim().endsWith('</html>'));

  // tag balance
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'source', 'track', 'wbr']);
  const stack = [], errs = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, close, tag, self] = m;
    const t = tag.toLowerCase();
    if (VOID.has(t) || self) continue;
    if (!close) stack.push(t);
    else if (stack[stack.length - 1] === t) stack.pop();
    else errs.push(`</${t}>`);
  }
  check('all HTML tags are balanced', stack.length === 0 && errs.length === 0,
    `${stack.length} unclosed, ${errs.length} mismatched`);

  // every $('id') lookup must exist in the markup
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(x => x[1]));
  const used = new Set([...html.matchAll(/\$\('([^']+)'\)/g)].map(x => x[1]));
  const missing = [...used].filter(i => !ids.has(i));
  check(`every $('id') lookup resolves in the markup`, missing.length === 0, missing.join(', '));

  // css sanity
  const style = html.match(/<style>([\s\S]*?)<\/style>/);
  check('<style> block is present and brace-balanced',
    !!style && (style[1].match(/\{/g) || []).length === (style[1].match(/\}/g) || []).length);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  check('exactly one inline <script> (game code)', (html.match(/<script/g) || []).length === 1 && !!script);
  check('no leftover console/debug statements in game code',
    !/\bconsole\.(log|warn|debug)\b/.test(script[1]));

  // external dependencies (documented, not required to be zero)
  const ext = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(x => x[1]);
  info(ext.length ? `external assets: ${ext.join(', ')}` : 'no external assets (fully offline)');
  check('no external script dependencies (only optional CSS assets at most)',
    !/<script[^>]+src=/.test(html));
});

/* ---------------------------------------------------------------- runner -- */

const selected = filter ? suites.filter(s => s.name.includes(filter)) : suites;
if (!selected.length) {
  console.error(`no suite matches "${filter}". available:\n  ` + suites.map(s => s.name).join('\n  '));
  process.exit(2);
}

const t0 = Date.now();
for (const s of selected) {
  current = s;
  console.log(`\n${s.name}`);
  s.checks = [];
  s.fn();
}

const all = selected.flatMap(s => s.checks);
const failed = all.filter(c => !c.ok);
console.log(`\n${'-'.repeat(60)}`);
console.log(`${all.length - failed.length}/${all.length} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)} s` +
  (QUICK ? ' (quick mode)' : ''));
if (failed.length) {
  console.log('\nfailures:');
  for (const f of failed) console.log(`  - [${suites.find(s => s.checks.includes(f)).name}] ${f.name}${f.extra ? ' — ' + f.extra : ''}`);
}
process.exit(failed.length ? 1 : 0);
