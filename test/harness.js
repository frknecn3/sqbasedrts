'use strict';
/*
 * Headless harness for index.html (Squad command).
 *
 * The game is a single HTML file with an inline script that expects a browser:
 * DOM lookups, a Canvas2D context, pointer/keyboard events and a
 * requestAnimationFrame loop. This harness supplies just enough of that
 * environment to run the *real* game script under Node - it patches nothing
 * inside index.html - so the tests exercise the same frame()/update()/render()
 * code the browser runs.
 *
 * What is stubbed vs. real:
 *   real  - all game logic: map generation, A*, combat, AI, objectives, input
 *           handlers, HUD/minimap code paths, draw-call sequence
 *   stub  - rasterisation itself (every Canvas2D call is a no-op that is
 *           counted), so tests can assert on how much is drawn and how fast
 *           the JS runs, but not on pixels.
 */

const fs = require('fs');
const path = require('path');

const GAME_HTML = path.join(__dirname, '..', 'index.html');

/* ---------------------------------------------------------------- canvas -- */

function makeCtx(canvas) {
  const noop = () => {};
  const grad = () => ({ addColorStop: noop });
  const ctx = {
    canvas,
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000',
    strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    imageSmoothingEnabled: true, lineDashOffset: 0,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop,
    arcTo: noop, ellipse: noop, rect: noop, fill: noop, stroke: noop,
    clip: noop, save: noop, restore: noop, translate: noop, rotate: noop,
    scale: noop, transform: noop, setTransform: noop, resetTransform: noop,
    fillRect: noop, strokeRect: noop, clearRect: noop, drawImage: noop,
    setLineDash: noop, getLineDash: () => [], fillText: noop, strokeText: noop,
    measureText: t => ({ width: String(t).length * 6 }),
    createRadialGradient: grad, createLinearGradient: grad,
    createPattern: () => null,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: noop,
  };
  // Wrap every method so tests can inspect draw-call volume per frame.
  const counts = {};
  for (const k of Object.keys(ctx)) {
    const v = ctx[k];
    if (typeof v === 'function') ctx[k] = (...a) => { counts[k] = (counts[k] || 0) + 1; return v(...a) };
  }
  ctx.calls = counts;
  return ctx;
}

/* -------------------------------------------------------------------- DOM -- */

class El {
  constructor(id) {
    this.id = id;
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.textContent = '';
    this._html = '';
    this.width = 300; this.height = 150;
    this.clientWidth = 680;
    this._lis = {};
    this.firstElementChild = { className: '' };
    this.lastChild = { textContent: '' };
    this.tagName = 'DIV';
    if (id === 'cv' || id === 'mm') this.ctx = makeCtx(this);
  }
  get innerHTML() { return this._html }
  set innerHTML(v) { this._html = v }
  getContext() { if (!this.ctx) this.ctx = makeCtx(this); return this.ctx }
  addEventListener(t, fn) { (this._lis[t] = this._lis[t] || []).push(fn) }
  removeEventListener() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight || 460 } }
  focus() {} setPointerCapture() {} releasePointerCapture() {} closest() { return null }
  querySelector() { return null }
  get offsetWidth() { return this.clientWidth }
}

function buildDom() {
  const ids = ['cv', 'mm', 'view', 'ov', 'ovt', 'ovp', 'ovb', 'pz', 'snd',
    'cards', 'obj', 'cp', 'kl', 'clk', 'dep', 'rts', 'bar', 'hint'];
  const els = {};
  for (const id of ids) els[id] = new El(id);
  els.view.clientWidth = 680;

  const doc = {
    body: { fontFamily: 'system-ui, sans-serif', appendChild() {} },
    documentElement: { style: {} },
    getElementById: id => els[id] || (els[id] = new El(id)),
    createElement: tag => new El('_' + tag),
    addEventListener() {}, removeEventListener() {},
    hidden: false,
  };

  const win = {
    devicePixelRatio: 1,
    _clock: 0,
    _lis: {},
    innerWidth: 1200, innerHeight: 800,
    addEventListener(t, fn) { (win._lis[t] = win._lis[t] || []).push(fn) },
    removeEventListener() {},
    requestAnimationFrame: cb => { win._raf = cb; return 1 },
    ResizeObserver: class { constructor(cb) { win._ro = cb } observe() {} disconnect() {} },
    getComputedStyle: () => ({ fontFamily: 'system-ui, sans-serif' }),
    performance: { now: () => win._clock },
  };
  return { doc, win, els };
}

/* ------------------------------------------------------------------- boot -- */

function loadGameScript() {
  const src = fs.readFileSync(GAME_HTML, 'utf8');
  const m = src.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no inline <script> found in index.html');
  return { script: m[1], html: src };
}

// Names injected into the game closure's scope when exposeInternals is set.
// Returned from the IIFE so tests can inspect and drive internal state.
const EXPOSED =
  'get squads(){return squads}, get soldiers(){return soldiers}, get flags(){return flags}, ' +
  'get state(){return state}, set state(v){state=v}, get cp(){return cp}, set cp(v){cp=v}, ' +
  'get kills(){return kills}, get gt(){return gt}, get err(){return err}, ' +
  'get waveI(){return waveI}, set waveI(v){waveI=v}, get waveT(){return waveT}, set waveT(v){waveT=v}, ' +
  'get cam(){return cam}, get parts(){return parts}, get bullets(){return bullets}, ' +
  'get corpses(){return corpses}, get nades(){return nades}, get marks(){return marks}, ' +
  'get msgs(){return msgs}, get sel(){return sel}, get vis(){return vis}, ' +
  'get hL(){return hL}, get hN(){return hN}, get nadeT(){return eNade}, ' +
  'get W(){return W}, get H(){return H}, get nadeMode(){return nadeMode}, set nadeMode(v){nadeMode=v}, get msgs(){return msgs}, ' +
  'N, PHQ, EHQ, STARTS, SPAWNS, GARR, PERMS, genMap, findPath, los, segClear, ' +
  'bp, block, ground, cover, water, statics: () => statics, makeSquad, addSoldier, ' +
  'deploy, reset, update, render, command, toW, ix, iy, checkEnd, capture';

/**
 * Boot the real game script against the stub DOM.
 * @param {{exposeInternals?: boolean}} opts
 */
function boot({ exposeInternals = false } = {}) {
  const { doc, win, els } = buildDom();
  let { script } = loadGameScript();
  if (exposeInternals) {
    const i = script.lastIndexOf('})();');
    script = script.slice(0, i) + 'return {' + EXPOSED + '};\n' + script.slice(i);
    script = 'globalThis.__G = ' + script;
  }
  const fn = new Function('window', 'document', 'performance', 'requestAnimationFrame',
    'ResizeObserver', 'getComputedStyle', 'globalThis', script);
  fn(win, doc, win.performance, win.requestAnimationFrame, win.ResizeObserver,
    win.getComputedStyle, globalThis);

  const dispatch = (list, ev) => { for (const f of list || []) f(ev) };
  const mkEv = (type, el, ev) => Object.assign({
    type, preventDefault() {}, stopPropagation() {}, target: el,
    clientX: 0, clientY: 0, button: 0, pointerId: 1, pointerType: 'mouse',
    code: '', key: '', shiftKey: false, ctrlKey: false, metaKey: false,
    deltaY: 0, repeat: false,
  }, ev);

  const fire = (el, type, ev = {}) => dispatch(el._lis[type], mkEv(type, el, ev));
  const fireWin = (type, ev = {}) => dispatch(win._lis[type], mkEv(type, null, ev));

  // Advance n animation frames of dt seconds each, mirroring requestAnimationFrame.
  let t = 0;
  const step = (n = 1, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) {
      t += dt * 1000;
      win._clock = t;
      const cb = win._raf; win._raf = null;
      if (cb) cb(t);
    }
  };

  return { win, doc, els, fire, fireWin, step, internals: () => globalThis.__G };
}

module.exports = { boot, loadGameScript, makeCtx, GAME_HTML };
