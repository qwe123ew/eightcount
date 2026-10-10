'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const staticRoot = fs.existsSync(path.join(repoRoot, 'dist', 'app.js')) ? path.join(repoRoot, 'dist') : repoRoot;

// Model actual ancestor matching. A target-only closest stub misses the search
// section's styling data-view attribute intercepting its quick-choice buttons.
function setup() {
  const elements = new Map();
  class Element {
    constructor(tag = 'div', parent = null) {
      this.tag = tag; this.parentElement = parent; this.dataset = {}; this.attributes = {};
      this.listeners = {}; this.value = ''; this.firstChild = {}; this.focusCalls = 0;
    }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    fire(name, event = {}) { for (const fn of this.listeners[name] || []) fn(event); }
    setAttribute(name, value) {
      this.attributes[name] = value;
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    matches(selector) {
      const attr = selector.match(/^(\w+)?\[data-([\w-]+)\]$/);
      if (attr) return (!attr[1] || this.tag === attr[1]) && attr[2].replace(/-([a-z])/g, (_, c) => c.toUpperCase()) in this.dataset;
      return selector === '.playlist-track' && this.className === 'playlist-track';
    }
    closest(selector) { for (let e = this; e; e = e.parentElement) if (e.matches(selector)) return e; return null; }
    querySelectorAll() { return []; }
    focus(options) { this.focusCalls++; this.focusOptions = options; }
  }
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const doc = new Element(); doc.getElementById = get; doc.querySelector = () => null;
  const navs = ['library', 'chart', 'playlists'].map(view => { const node = new Element('button'); node.dataset.view = view; return node; });
  doc.querySelectorAll = selector => [...navs, get('search-area')].filter(e => e.matches(selector));
  const ctx = {document: doc, window: new Element(), URL, URLSearchParams, AbortController, CSS: {escape: s => s},
    location: {search: '', href: 'https://example.test/'},
    history: {entries: [], replaceState(a, b, url) { this.current = String(url); }, pushState(a, b, url) { this.entries.push(String(url)); this.current = String(url); }}};
  vm.createContext(ctx);
  for (const file of ['catalog.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(staticRoot, file), 'utf8'), ctx);
  const click = target => doc.fire('click', {target});
  const quick = query => { const row = new Element('div', get('search-area')); const button = new Element('button', row); button.dataset.query = query; return button; };
  return {get, ctx, Element, navs, click, quick};
}

for (const [query, song] of [['宋雨琦', 'FREAK'], ['i-dle', 'Queencard'], ['BLACKPINK', 'How You Like That'], ['镜面', null]]) {
  test(`homepage quick choice ${query} is not intercepted by its data-view ancestor`, () => {
    const h = setup(), button = h.quick(query);
    assert.match(fs.readFileSync(path.join(staticRoot, 'index.html'), 'utf8'), new RegExp('data-query="' + query + '"'));
    assert.equal(button.closest('[data-view]'), h.get('search-area'));
    h.click(button);
    if (query === '镜面') {
      assert.match(h.get('active-filter').innerHTML, /data-remove-filter="type"/);
      assert.equal(new URL(h.ctx.history.current).searchParams.get('type'), '镜面');
    } else {
      assert.equal(h.get('search').value, query);
      assert.match(h.get('grid').innerHTML, new RegExp(song));
      assert.equal(new URL(h.ctx.history.current).searchParams.get('q'), query);
    }
    assert.equal(h.get('library-panel').hidden, false);
    assert.equal(h.get('search').focusCalls, 0);
    assert.equal(h.get('result-heading').focusCalls, 1);
    assert.equal(h.get('result-heading').focusOptions.preventScroll, true);
  });
}

test('nested content in a quick button still invokes the containing quick choice', () => {
  const h = setup(), button = h.quick('宋雨琦');
  h.click(new h.Element('span', button));
  assert.equal(h.get('search').value, '宋雨琦');
});

test('non-navigation search-area clicks leave the active view and history unchanged', () => {
  const h = setup(); h.click(h.navs[1]);
  const before = h.ctx.history.entries.length;
  for (const target of [h.get('search-area'), new h.Element('div', h.get('search-area')), new h.Element('input', h.get('search-area'))]) h.click(target);
  assert.equal(h.ctx.history.entries.length, before);
  assert.equal(h.get('chart-panel').hidden, false);
  assert.equal(h.get('library-panel').hidden, true);
});

test('real navigation buttons and their descendants still switch chart, playlists and library', () => {
  const h = setup();
  for (const [index, visible, hidden] of [[1, 'chart-panel', 'library-panel'], [2, 'imported-playlists', 'chart-panel'], [0, 'library-panel', 'imported-playlists']]) {
    h.click(new h.Element('span', h.navs[index]));
    assert.equal(h.get(visible).hidden, false);
    assert.equal(h.get(hidden).hidden, true);
    assert.equal(h.navs[index].attributes['aria-pressed'], 'true');
    assert.equal(h.navs.filter(n => n.attributes['aria-pressed'] === 'true').length, 1);
  }
  assert.equal(h.ctx.history.entries.length, 3);
});

test('aria-pressed is assigned only to navigation buttons, never the layout section', () => {
  const h = setup();
  for (const button of [h.navs[0], h.navs[1], h.navs[2]]) {
    h.click(button);
    assert.equal(h.get('search-area').attributes['aria-pressed'], undefined);
    assert.equal(h.get('search-area').dataset.view, button.dataset.view, 'styling state remains available');
  }
});
