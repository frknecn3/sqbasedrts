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

function textNode(t) { const n = { nodeType: 3, nodeValue: String(t), parentNode: null, children: [], className: '' }; Object.defineProperty(n, 'textContent', { get: () => n.nodeValue, set: v => { n.nodeValue = String(v) } }); return n }

class El {
  constructor(id, tag = 'DIV') {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.dataset = {};
    this.children = [];                 // element + text children, in order (dom childNodes)
    this.parentNode = null;
    this._text = '';
    this._html = '';
    this.width = 300; this.height = 150;
    this.clientWidth = 680;
    this._lis = {};
    this.className = '';
    this.disabled = false;
    this.title = '';
    if (id === 'cv' || id === 'mm') this.ctx = makeCtx(this);
  }
  // textContent on an element concatenates its children (setting it replaces them)
  get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this._text }
  set textContent(v) { this.children = []; this._text = String(v) }
  get innerHTML() { return this._html }
  set innerHTML(v) { this._html = v }
  get lastChild() { return this.children.length ? this.children[this.children.length - 1] : null }
  get firstChild() { return this.children[0] || null }
  get firstElementChild() { return this.children.find(c => c.nodeType !== 3) || null }
  get childNodes() { return this.children }
  appendChild(c) { if (c && c.parentNode) c.parentNode.removeChild(c); this.children.push(c); if (c) c.parentNode = this; return c }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null } return c }
  insertBefore(c, ref) { if (!ref) return this.appendChild(c); const i = this.children.indexOf(ref); return i < 0 ? this.appendChild(c) : (this.children.splice(i, 0, c), c.parentNode = this, c) }
  remove() { if (this.parentNode) this.parentNode.removeChild(this) }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, '');
    const out = [];
    const walk = el => { for (const c of el.children) if (c.nodeType !== 3) { if (c.className && c.className.split(/\s+/).includes(cls)) out.push(c); walk(c) } };
    walk(this); return out;
  }
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
  // mirror the static markup the script expects to find (buttons carry an icon node)
  els.ovb.appendChild(new El('_i', 'i'));
  els.ovb.appendChild(textNode(' Deploy'));
  els.pz.appendChild(new El('_i', 'i'));
  els.snd.appendChild(new El('_i', 'i'));
  els.bar.appendChild(els.pz);

  const doc = {
    body: { fontFamily: 'system-ui, sans-serif', appendChild() {} },
    documentElement: { style: {} },
    getElementById: id => els[id] || (els[id] = new El(id)),
    createElement: tag => new El('_' + tag),
    createTextNode: t => textNode(t),
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

/**
 * Boot the real game script against the stub DOM and return handles to it.
 *
 * The game publishes its extension API on `window.SquadCommand.api`; this harness
 * just supplies the window. Nothing inside index.html is rewritten, so a run
 * exercises exactly the code a browser would execute.
 *
 * @returns {{win: Object, doc: Object, els: Object, fire: Function, fireWin: Function,
 *            step: Function, api: Object}}
 *   `els` holds the stub elements by id (cv, mm, view, ov, ovt, ovp, ovb, bar, pz, ...),
 *   `fire(el, type, ev)` dispatches a DOM event at an element, `fireWin(type, ev)` at
 *   the window, `step(n, dt)` advances n animation frames (default dt = 1/60 s) and
 *   `api` is the game's public API (see the header of index.html).
 */
function boot() {
  const { doc, win, els } = buildDom();
  const { script } = loadGameScript();
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

  const api = win.SquadCommand && win.SquadCommand.api;
  if (!api) throw new Error('index.html did not publish window.SquadCommand.api');
  return { win, doc, els, fire, fireWin, step, api };
}

module.exports = { boot, loadGameScript, makeCtx, GAME_HTML };
