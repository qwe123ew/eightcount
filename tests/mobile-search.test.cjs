'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const staticRoot = fs.existsSync(path.join(repoRoot, 'dist', 'app.js')) ? path.join(repoRoot, 'dist') : repoRoot;

// These fixtures inspect application work and focus intent, not mobile browser layout.
function setup() {
  const elements = new Map();
  class Element {
    constructor() { this.listeners = {}; this.value = ''; this.firstChild = {}; this.writes = 0; this.focusCalls = 0; this.isConnected = true; }
    get innerHTML() { return this.html || ''; }
    set innerHTML(value) { this.html = value; this.writes++; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    fire(name, event = {}) { for (const fn of this.listeners[name] || []) fn(event); }
    querySelectorAll() { return []; }
    setAttribute(name, value) { this[name] = value; }
    focus(options) { this.focusCalls++; this.focusOptions = options; }
  }
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const doc = new Element(); doc.getElementById = get; doc.querySelector = () => null;
  const ctx = { document: doc, window: new Element(), location: { search: '', href: 'https://example.test/' },
    history: { entries: [], replaceState(a, b, url) { this.current = String(url); }, pushState(a, b, url) { this.entries.push(String(url)); this.current = String(url); } },
    URL, URLSearchParams, CSS: { escape: s => s }, AbortController };
  vm.createContext(ctx);
  vm.runInContext(`globalThis.normalizations = 0; const originalNormalize = String.prototype.normalize;
    String.prototype.normalize = function (...args) { globalThis.normalizations++; return originalNormalize.apply(this, args); };`, ctx);
  for (const file of ['catalog.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(staticRoot, file), 'utf8'), ctx);
  const click = (selector, node) => doc.fire('click', { target: { closest: s => s === selector ? node : null } });
  const input = value => { get('search').value = value; get('search').fire('input'); };
  const nav = view => click('button[data-view]', { dataset: { view } });
  return { get, ctx, click, input, nav };
}

test('IME commits once without rebuilding cards for its trailing input or unchanged submit', () => {
  const h = setup(), search = h.get('search'), grid = h.get('grid');
  const initial = grid.writes;
  search.fire('compositionstart'); h.input('song');
  assert.equal(grid.writes, initial);
  search.value = '宋雨琦'; search.fire('compositionend');
  assert.equal(grid.writes, initial + 1);
  assert.match(grid.innerHTML, /FREAK/);
  search.fire('input', { isComposing: false });
  h.get('search-form').fire('submit', { preventDefault() {} });
  assert.equal(grid.writes, initial + 1, 'same committed query must retain already mounted covers');
});

test('successive inputs and immediate view changes use the latest committed query synchronously', () => {
  const h = setup();
  for (const query of ['B', 'BT', 'BTS']) h.input(query);
  assert.match(h.get('grid').innerHTML, /Dynamite/);
  assert.doesNotMatch(h.get('grid').innerHTML, /BLACKPINK/);
  assert.equal(new URL(h.ctx.history.current).searchParams.get('q'), 'BTS');
  h.nav('chart'); h.input('BTS SWIM');
  assert.equal((h.get('chart-tracks').innerHTML.match(/class="chart-track"/g) || []).length, 1);
  h.nav('library');
  assert.equal(h.get('search').value, 'BTS SWIM');
  assert.equal(new URL(h.ctx.history.current).searchParams.get('q'), 'BTS SWIM');
  assert.match(h.get('grid').innerHTML, /SWIM/);
});

test('chart search and navigation do not replace hidden library covers', () => {
  const h = setup(), grid = h.get('grid');
  const initial = grid.writes;
  h.nav('chart'); h.input('BTS SWIM');
  assert.equal(grid.writes, initial);
  h.nav('library');
  assert.equal(grid.writes, initial + 1);
});

test('unfinished IME text is not committed by navigation and its completion updates the current view', () => {
  const h = setup(); h.input('BTS');
  h.get('search').fire('compositionstart'); h.input('宋雨琦'); h.nav('chart');
  assert.equal(new URL(h.ctx.history.current).searchParams.get('q'), 'BTS');
  h.get('search').fire('compositionend'); h.get('search').fire('input');
  assert.equal(new URL(h.ctx.history.current).searchParams.get('q'), '宋雨琦');
  assert.equal(new URL(h.ctx.history.current).searchParams.get('view'), 'chart');
  h.nav('library'); assert.match(h.get('grid').innerHTML, /FREAK/);
});

test('unchanged catalog navigation keeps mounted cards and pagination', () => {
  const h = setup(), grid = h.get('grid');
  h.get('load-more').fire('click'); const initial = grid.writes;
  h.nav('chart'); h.nav('library');
  assert.equal(grid.writes, initial);
  assert.equal((grid.innerHTML.match(/class="track-card"/g) || []).length, 48);
});

test('a search reuses the static source index instead of normalizing every source for every facet', () => {
  const h = setup(); h.ctx.normalizations = 0;
  h.input('BTS');
  assert(h.ctx.normalizations < 100, `single-token search normalized ${h.ctx.normalizations} strings`);
  assert.match(h.get('grid').innerHTML, /Dynamite/);
});

test('filter resets focus the stable results heading without focusing or scrolling to the input', () => {
  const h = setup(); h.input('BTS');
  h.get('reset').fire('click');
  assert.equal(h.get('search').focusCalls, 0);
  assert.equal(h.get('result-heading').focusCalls, 1);
  assert.equal(h.get('result-heading').tabindex, '-1');
  assert.equal(h.get('result-heading').focusOptions.preventScroll, true);
  assert.equal(h.get('search').value, '');
});

test('quick choices, removing chips and empty reset preserve non-input focus', () => {
  const h = setup();
  h.click('[data-query]', { dataset: { query: '宋雨琦' }, closest: () => null });
  assert.match(h.get('grid').innerHTML, /FREAK/);
  h.click('[data-remove-filter]', { dataset: { removeFilter: 'query' } });
  h.input('nothing matches 123'); h.get('empty-reset').fire('click');
  h.click('[data-clear-filters]', {});
  assert.equal(h.get('search').focusCalls, 0);
  assert.equal(h.get('result-heading').focusCalls, 4);
  assert.equal(h.get('result-heading').focusOptions.preventScroll, true);
});

test('indexed matching retains source-level filtering, aliases, token order and domestic-first ordering', () => {
  const app = require(path.join(staticRoot, 'app.js')), data = {};
  vm.runInNewContext(fs.readFileSync(path.join(staticRoot, 'catalog.js'), 'utf8'), data);
  const groups = app.groupVideos(data.EIGHTCOUNT_DATA.videos);
  const extra = { '舞台': 'live stage 现场 舞台', '翻跳': 'cover dance 翻跳 舞蹈', '练习室': 'dance practice 练习 舞蹈 排练', '镜面': 'mirror mirrored 镜像', '分解教学': 'tutorial 教程 教学 分解 慢速', '编舞视频': 'choreography performance 编舞 舞蹈' };
  function reference(state) {
    const tokens = String(state.query || '').trim().split(/\s+/).map(app.normalize).filter(Boolean);
    return groups.map(g => ({ ...g, matched: g.sources.filter(v =>
      (!state.domestic || app.isDomestic(v)) && (!state.region || (v.region || '韩流') === state.region) &&
      (!state.artist || g.artist === state.artist) && app.matchesType(v, state.type) && (!state.platform || v.platform === state.platform) &&
      tokens.every(t => app.normalize([g.song, g.artist, ...g.aliases, v.title, v.type, extra[v.type] || '', v.platform, v.uploader].join(' ')).includes(t)))
    })).filter(g => g.matched.length).sort((a, b) => Number(b.matched.some(app.isDomestic)) - Number(a.matched.some(app.isDomestic)));
  }
  const summarize = rows => rows.map(g => [g.id, g.matched.map(v => v.url)]);
  const queries = ['', '宋雨琦', 'ＳＥＶＥＮＴＥＥＮ', 'SWIM BTS', 'BTS SWIM', 'Gods Menu', 'mirror', '粉墨', 'unfound xyz'];
  const states = queries.map(query => ({ query }));
  for (const type of ['', '练习室', '镜面', '分解教学', '编舞视频', '翻跳', '舞台'])
    for (const platform of ['', ...new Set(data.EIGHTCOUNT_DATA.videos.map(v => v.platform))]) states.push({ type, platform });
  for (const region of ['韩流', '华语', '欧美', '日本', '其他']) states.push({ region, domestic: true });
  states.push({ artist: 'BTS', query: 'dance', domestic: true }, { type: '镜面', platform: 'B站', query: 'practice' });
  for (const state of states) assert.deepEqual(summarize(app.results(groups, state)), summarize(reference(state)), JSON.stringify(state));
});
