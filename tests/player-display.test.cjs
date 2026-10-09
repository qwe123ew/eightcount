'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const staticRoot = fs.existsSync(path.join(repoRoot, 'dist', 'app.js')) ? path.join(repoRoot, 'dist') : repoRoot;
const app = require(path.join(staticRoot, 'app.js'));

// DOM substitutes exercise our controller, not a browser's Fullscreen implementation.
class Element {
  constructor() { this.attributes = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.isConnected = true; this.children = []; this.textContent = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, fn, options = {}) { (this.listeners[name] ||= new Set()).add(fn); options.signal?.addEventListener('abort', () => this.listeners[name].delete(fn), { once: true }); }
  fire(name, event = {}) { for (const fn of this.listeners[name] || []) fn(event); }
  contains(element) { return this.children.includes(element); }
  focus() { this.focused = true; }
}
function setup(config = {}) {
  assert.equal(typeof app.createPlayerDisplay, 'function', 'A player display controller must provide honest fullscreen fallback');
  const doc = new Element(), panel = new Element(), dialog = new Element();
  const fullscreenButton = new Element(), pageButton = new Element(), backButton = new Element(), status = new Element();
  const timers = new Map(); let timerId = 0, backCount = 0;
  if (config.request) panel.requestFullscreen = function () { return config.request.call(panel, doc); };
  if (config.webkitRequest) panel.webkitRequestFullscreen = function () { return config.webkitRequest.call(panel, doc); };
  if ('enabled' in config) doc.fullscreenEnabled = config.enabled;
  if ('webkitEnabled' in config) doc.webkitFullscreenEnabled = config.webkitEnabled;
  doc.exitFullscreen = config.exit || function () { doc.fullscreenElement = null; doc.fire('fullscreenchange'); return Promise.resolve(); };
  const controller = app.createPlayerDisplay({ doc, panel, dialog, fullscreenButton, pageButton, backButton, status,
    onBack() { backCount++; }, setTimer(fn) { timers.set(++timerId, fn); return timerId; }, clearTimer(id) { timers.delete(id); } });
  return { doc, panel, dialog, fullscreenButton, pageButton, backButton, status, controller,
    mode: () => panel.getAttribute('data-player-mode'), backCount: () => backCount,
    flushTimers() { for (const [id, fn] of timers) { timers.delete(id); fn(); } } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('unsupported fullscreen advertises page expansion and never reports native fullscreen', () => {
  const h = setup();
  assert.equal(h.fullscreenButton.textContent, '页面大屏');
  assert.equal(h.pageButton.hidden, true);
  h.controller.toggle();
  assert.equal(h.mode(), 'page');
  assert.equal(h.dialog.getAttribute('data-player-expanded'), 'true');
  assert.match(h.status.textContent, /页面大屏/);
  assert.match(h.status.textContent, /浏览器|系统/);
  assert.equal(h.fullscreenButton.textContent, '退出大屏');
  h.controller.toggle();
  assert.equal(h.mode(), 'inline');
  assert.equal(h.dialog.getAttribute('data-player-expanded'), 'false');
});

test('document policy denial chooses page expansion without invoking native API', () => {
  let requests = 0;
  const h = setup({ enabled: false, request() { requests++; } });
  h.controller.toggle();
  assert.equal(requests, 0);
  assert.equal(h.mode(), 'page');
});

test('native fullscreen request occurs synchronously in the initiating click and targets the player section', async () => {
  let called = false, target;
  const h = setup({ request(doc) { called = true; target = this; doc.fullscreenElement = this; doc.fire('fullscreenchange'); return Promise.resolve(); } });
  h.controller.toggle();
  assert.equal(called, true);
  assert.equal(target, h.panel);
  assert.notEqual(target, h.dialog);
  await settle();
  assert.equal(h.mode(), 'native');
  assert.equal(h.fullscreenButton.textContent, '退出全屏');
  assert.equal(h.backButton.hidden, false);
  h.controller.toggle();
  await settle();
  assert.equal(h.mode(), 'inline');
});

test('rejected fullscreen falls back to page expansion with visible explanation', async () => {
  const h = setup({ request() { return Promise.reject(new Error('Permission denied')); } });
  h.controller.toggle(); await settle();
  assert.equal(h.mode(), 'page');
  assert.match(h.status.textContent, /未能.*全屏/);
  assert.match(h.status.textContent, /页面大屏/);
  assert.equal(h.fullscreenButton.disabled, false);
});

test('synchronous API errors also reach a usable page fallback', () => {
  const h = setup({ request() { throw new TypeError('Not supported'); } });
  assert.doesNotThrow(() => h.controller.toggle());
  assert.equal(h.mode(), 'page');
});

test('a fulfilled request without a fullscreen element is not falsely declared successful', async () => {
  const h = setup({ request() { return Promise.resolve(); } });
  h.controller.toggle(); await settle();
  assert.equal(h.mode(), 'page');
});

test('prefixed WebKit fullscreen uses its change event, and system exit restores controls', () => {
  const h = setup({ webkitRequest(doc) { doc.webkitFullscreenElement = this; doc.fire('webkitfullscreenchange'); } });
  h.controller.toggle();
  assert.equal(h.mode(), 'native');
  h.doc.webkitFullscreenElement = null;
  h.doc.fire('webkitfullscreenchange');
  assert.equal(h.mode(), 'inline');
  assert.equal(h.fullscreenButton.textContent, '全屏观看');
});

test('a legacy fullscreen API with no promise or event times out to a visible fallback', () => {
  const h = setup({ webkitRequest() {} });
  h.controller.toggle(); h.flushTimers();
  assert.equal(h.mode(), 'page');
  assert.equal(h.fullscreenButton.disabled, false);
});

test('repeated clicks while requesting fullscreen do not create overlapping requests', () => {
  let requests = 0;
  const h = setup({ request() { requests++; return new Promise(() => {}); } });
  h.controller.toggle(); h.controller.toggle();
  assert.equal(requests, 1);
});

test('page expansion is an explicit alternative even where native fullscreen is available', () => {
  let requests = 0;
  const h = setup({ request() { requests++; } });
  assert.equal(h.pageButton.hidden, false);
  h.controller.expandPage();
  assert.equal(h.mode(), 'page');
  assert.equal(requests, 0);
  h.controller.back();
  assert.equal(h.mode(), 'inline');
  assert.equal(h.backCount(), 1);
});

test('close or source replacement clears expanded state and ignores a late rejection', async () => {
  let reject;
  const h = setup({ request() { return new Promise((resolve, no) => { reject = no; }); } });
  h.controller.toggle(); h.controller.destroy();
  reject(new Error('Late failure')); await settle();
  assert.equal(h.mode(), 'inline');
  assert.equal(h.dialog.getAttribute('data-player-expanded'), 'false');
  assert.equal(h.controller.isExpanded(), false);
  assert.equal(h.doc.listeners.fullscreenchange.size, 0);
});

test('closing fullscreen exits only the owned player and preserves unrelated fullscreen', async () => {
  let exits = 0;
  const h = setup({ exit() { exits++; return Promise.resolve(); } });
  h.doc.fullscreenElement = new Element();
  h.controller.destroy(); await settle();
  assert.equal(exits, 0);
  const owned = setup({ exit() { exits++; return Promise.resolve(); } });
  owned.doc.fullscreenElement = owned.panel;
  owned.controller.destroy(); await settle();
  assert.equal(exits, 1);
});

test('failed fullscreen exit retains native state and gives browser-exit guidance', async () => {
  const h = setup({ request(doc) { doc.fullscreenElement = this; return Promise.resolve(); }, exit() { return Promise.reject(new Error('Exit denied')); } });
  h.controller.toggle(); await settle();
  h.controller.back(); await settle();
  assert.equal(h.mode(), 'native');
  assert.match(h.status.textContent, /浏览器|手势/);
  assert.equal(h.backCount(), 0);
});

test('iframe permissions and external-only behavior remain explicit', () => {
  const source = fs.readFileSync(path.join(staticRoot, 'app.js'), 'utf8');
  assert.match(source, /allow="fullscreen; encrypted-media; picture-in-picture" allowfullscreen/);
  assert.equal(app.embedURL('https://www.douyin.com/video/123'), null);
  assert.equal(app.embedURL('https://vimeo.com/123'), null);
  assert.match(source, /此来源暂不支持站内播放/);
  assert.doesNotMatch(source, /contentDocument|contentWindow\.document|webkitEnterFullscreen/);
});

test('responsive player stylesheet contains dynamic-height and safe-area fallbacks without forced rotation', () => {
  const css = fs.readFileSync(path.join(staticRoot, 'style.css'), 'utf8');
  assert.match(css, /data-player-expanded/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /safe-area-inset-left/);
  assert.match(css, /100dvh/);
  assert.match(css, /orientation:\s*landscape/);
  assert.doesNotMatch(css, /rotate\(90deg\)/);
});

function setupApp() {
  const elements = new Map();
  class Node extends Element {
    constructor() { super(); this.innerHTML = ''; this.value = ''; this.open = false; this.firstChild = { textContent: '' }; }
    querySelectorAll() { return []; }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire('close'); }
    scrollIntoView(options) { this.scrollOptions = options; }
  }
  const get = id => { if (!elements.has(id)) elements.set(id, new Node()); return elements.get(id); };
  const doc = new Node(); doc.getElementById = get; doc.querySelector = () => null;
  const ctx = { document: doc, window: new Node(), location: { search: '', href: 'https://example.test/' }, history: { replaceState() {}, pushState() {} }, URL, URLSearchParams, CSS: { escape: s => s }, AbortController, setTimeout, clearTimeout };
  vm.createContext(ctx);
  for (const file of ['catalog.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(staticRoot, file), 'utf8'), ctx);
  const click = (selector, node) => doc.fire('click', { target: { closest: s => s === selector ? node : null } });
  const trigger = new Node(); trigger.dataset = { song: 'blackpink-howyoulikethat' }; click('[data-song]', trigger);
  const watch = new Node(); watch.dataset = { watch: 'https://www.youtube.com/watch?v=32si5cfrCNc' };
  return { get, click, trigger, watch, Node, doc };
}

test('app click wiring enters page mode, Escape returns to versions, and close unloads playback', () => {
  const h = setupApp(); h.click('[data-watch]', h.watch);
  assert.match(h.get('watch-panel').innerHTML, /data-player-fullscreen/);
  assert.match(h.get('watch-panel').innerHTML, /data-player-page/);
  assert.match(h.get('watch-panel').innerHTML, /data-player-back/);
  assert.match(h.get('watch-panel').innerHTML, /role="status" aria-live="polite"/);
  h.click('[data-player-fullscreen]', h.get('player-fullscreen'));
  assert.equal(h.get('player-surface').getAttribute('data-player-mode'), 'page');
  let prevented = false;
  h.get('song-dialog').fire('cancel', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.get('player-surface').getAttribute('data-player-mode'), 'inline');
  assert.equal(h.get('song-dialog').open, true);
  assert.equal(h.watch.focused, true);
  h.get('song-dialog').close();
  assert.equal(h.get('song-detail').innerHTML, '');
  assert.equal(h.trigger.focused, true);
});

test('choosing another video clears expanded state and replaces the iframe URL', () => {
  const h = setupApp(); h.click('[data-watch]', h.watch);
  h.click('[data-player-page]', h.get('player-page'));
  assert.equal(h.get('song-dialog').getAttribute('data-player-expanded'), 'true');
  const next = new h.Node(); next.dataset = { watch: 'https://www.bilibili.com/video/BV1B7411m7LV' };
  // Select an actual catalog source, preserving exact URL matching.
  const sandbox = {}; vm.createContext(sandbox); vm.runInContext(fs.readFileSync(path.join(staticRoot, 'catalog.js'), 'utf8'), sandbox);
  next.dataset.watch = sandbox.EIGHTCOUNT_DATA.videos.find(v => app.embedURL(v.url)?.includes('player.bilibili.com')).url;
  h.click('[data-watch]', next);
  assert.equal(h.get('player-surface').getAttribute('data-player-mode'), 'inline');
  assert.equal(h.get('song-dialog').getAttribute('data-player-expanded'), 'false');
  assert.match(h.get('watch-panel').innerHTML, /player\.bilibili\.com/);
  assert.doesNotMatch(h.get('watch-panel').innerHTML, /youtube-nocookie/);
});

test('external-only views never render fullscreen controls or an empty iframe', () => {
  const h = setupApp(); h.get('song-dialog').close();
  h.click('[data-filter]', { dataset: { filter: 'platform', value: 'Vimeo' } });
  const trigger = new h.Node(); trigger.dataset = { song: 'idle-queencard' }; h.click('[data-song]', trigger);
  const markup = h.get('song-detail').innerHTML;
  assert.match(markup, /此版本请前往原站观看/);
  assert.doesNotMatch(markup, /data-player-fullscreen|<iframe|data-watch=/);
});

test('late native success after destruction exits that abandoned player', async () => {
  let resolve, exits = 0;
  const h = setup({ request() { return new Promise(done => { resolve = done; }); }, exit() { exits++; return Promise.resolve(); } });
  h.controller.toggle(); h.controller.destroy();
  h.doc.fullscreenElement = h.panel;
  resolve(); await settle();
  assert.equal(h.mode(), 'inline');
  assert.equal(exits, 1);
});

test('delayed prefixed fullscreen exit returns focus to versions once its change event arrives', async () => {
  const h = setup({ webkitRequest(doc) { doc.webkitFullscreenElement = this; doc.fire('webkitfullscreenchange'); } });
  delete h.doc.exitFullscreen;
  h.doc.webkitExitFullscreen = () => {};
  h.controller.toggle(); h.controller.back(); await settle();
  assert.equal(h.backCount(), 0);
  h.doc.webkitFullscreenElement = null;
  h.doc.fire('webkitfullscreenchange');
  assert.equal(h.backCount(), 1);
  assert.equal(h.mode(), 'inline');
});

test('a destroyed request cannot exit a different new player that entered fullscreen', async () => {
  let resolve, exits = 0;
  const h = setup({ request() { return new Promise(done => { resolve = done; }); }, exit() { exits++; return Promise.resolve(); } });
  h.controller.toggle(); h.controller.destroy();
  h.doc.fullscreenElement = new Element();
  resolve(); await settle();
  assert.equal(exits, 0);
});
