'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const staticRoot = fs.existsSync(path.join(repoRoot, 'dist', 'app.js')) ? path.join(repoRoot, 'dist') : repoRoot;
const decode = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// A small DOM substitute retains node identity, attributes, image listener/src
// history and focus. It does not make requests or validate browser layout.
function setup() {
  const elements = new Map(); let doc;
  class Element {
    constructor(tag = 'div', parent = null) {
      this.tag = tag; this.parentElement = parent; this.dataset = {}; this.attributes = {};
      this.listeners = {}; this.children = []; this.value = ''; this.firstChild = {};
      this.isConnected = true; this.srcHistory = []; this.html = ''; this.replacements = 0; this.appends = 0;
    }
    addEventListener(name, fn) { (this.listeners[name] ||= new Set()).add(fn); }
    removeEventListener(name, fn) { this.listeners[name]?.delete(fn); }
    fire(name, event = {}) { for (const fn of [...(this.listeners[name] || [])]) fn(event); }
    setAttribute(name, value) { this.attributes[name] = value; if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value; }
    matches(selector) {
      if (selector.startsWith('.')) return this.className === selector.slice(1);
      const attr = selector.match(/^(\w+)?\[data-([\w-]+)\]$/);
      return !!attr && (!attr[1] || this.tag === attr[1]) && attr[2].replace(/-([a-z])/g, (_, c) => c.toUpperCase()) in this.dataset;
    }
    closest(selector) { for (let e = this; e; e = e.parentElement) if (e.matches(selector)) return e; return null; }
    querySelectorAll(selector) { return this.children.flatMap(e => [...(e.matches(selector) ? [e] : []), ...e.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    disconnect() { this.isConnected = false; for (const child of this.children) child.disconnect(); }
    remove() { this.disconnect(); this.parentElement.children = this.parentElement.children.filter(e => e !== this); }
    set src(value) { this._src = value; this.srcHistory.push(value); }
    get src() { return this._src; }
    focus() { doc.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire('close'); }
    set innerHTML(value) {
      this.replacements++; this.html = value;
      for (const child of this.children) child.disconnect(); this.children = [];
      if (this === elements.get('grid')) this.parseCards(value);
    }
    get innerHTML() { return this.html; }
    insertAdjacentHTML(position, value) {
      assert.equal(position, 'beforeend'); this.appends++; this.html += value;
      if (this === elements.get('grid')) this.parseCards(value);
    }
    parseCards(value) {
      for (const match of value.matchAll(/<article class="track-card">([\s\S]*?)<\/article>/g)) {
        const html = match[1], article = new Element('article', this); article.className = 'track-card';
        article.number = html.match(/class="card-num">(\d+)</)?.[1];
        const cover = new Element('button', article); cover.className = 'cover-button';
        cover.dataset.song = decode(html.match(/data-song="([^"]+)"/)[1]); cover.dataset.coverState = html.match(/data-cover-state="([^"]+)"/)[1];
        const status = new Element('span', cover); status.dataset.coverStatus = ''; status.hidden = /data-cover-status hidden/.test(html); cover.children.push(status);
        const candidates = html.match(/<img data-cover-candidates="([^"]+)"/);
        if (candidates) { const img = new Element('img', cover); img.dataset.coverCandidates = decode(candidates[1]); img.naturalWidth = 640; img.naturalHeight = 360; cover.children.push(img); }
        article.children.push(cover); this.children.push(article);
      }
    }
  }
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  doc = new Element(); doc.getElementById = get; doc.querySelector = () => null; doc.querySelectorAll = () => [];
  const ctx = {document: doc, window: new Element(), URL, URLSearchParams, AbortController, CSS: {escape: s => s}, location: {search: '', href: 'https://example.test/'}, history: {replaceState() {}, pushState() {}}};
  vm.createContext(ctx);
  for (const file of ['catalog.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(staticRoot, file), 'utf8'), ctx);
  const click = (selector, dataset) => { const node = new Element('button'); node.dataset = dataset; doc.fire('click', {target: node}); };
  return {get, doc, ctx, click, covers: () => get('grid').querySelectorAll('.cover-button'),
    image: cover => cover.children.find(e => e.tag === 'img'),
    more: () => get('load-more').fire('click'), nav: view => click('button[data-view]', {view}),
    input: query => { get('search').value = query; get('search').fire('input'); },
    filter: (filter, value) => click('[data-filter]', {filter, value})};
}
const ids = h => h.covers().map(e => e.dataset.song);

// A full grid replacement, or binding every old img again, must fail these tests.
test('more retains ready cover nodes and the successful fallback rather than retrying a failed URL', () => {
  const h = setup(), previous = h.covers(), image = h.image(previous[0]);
  const failed = image.src; image.fire('error'); const good = image.src; image.fire('load');
  assert.notEqual(good, failed); assert.equal(previous[0].dataset.coverState, 'ready');
  const requests = image.srcHistory.length; h.more();
  assert.equal(h.covers().length, 48); assert.equal(h.covers()[0] === previous[0], true);
  assert.equal(h.image(h.covers()[0]), image); assert.equal(image.src, good);
  assert.equal(image.srcHistory.length, requests); assert.equal(previous[0].dataset.coverState, 'ready');
  for (let i = 0; i < 24; i++) assert.equal(h.covers()[i], previous[i]);
});

test('more preserves an in-flight fallback with exactly one error handler', () => {
  const h = setup(), cover = h.covers()[0], image = h.image(cover);
  image.fire('error'); const pendingURL = image.src; const count = image.srcHistory.length;
  h.more(); assert.equal(h.covers()[0] === cover, true); assert.equal(image.src, pendingURL);
  assert.equal(image.listeners.error.size, 1); image.fire('error');
  assert.equal(image.srcHistory.length, count + 1); assert.notEqual(image.src, pendingURL);
});

test('an exhausted cover stays unavailable after more instead of recreating the failed image', () => {
  const h = setup(), cover = h.covers()[0], image = h.image(cover);
  while (image.listeners.error?.size) image.fire('error');
  assert.equal(cover.dataset.coverState, 'unavailable'); assert.equal(h.image(cover), undefined);
  h.more(); assert.equal(h.covers()[0] === cover, true); assert.equal(h.image(h.covers()[0]), undefined);
  assert.equal(cover.dataset.coverState, 'unavailable'); assert.equal(cover.querySelector('[data-cover-status]').hidden, false);
});

test('new covers are bound once, focus starts the new page, and appended cards still open', () => {
  const h = setup(); h.more(); const next = h.covers()[24], image = h.image(next);
  assert.equal(h.doc.activeElement, next); assert.equal(image.srcHistory.length, 1);
  image.fire('load'); assert.equal(next.dataset.coverState, 'ready');
  h.doc.fire('click', {target: next}); assert.equal(h.get('song-dialog').open, true);
  assert.match(h.get('song-detail').innerHTML, /song-dialog-title/);
  h.get('song-dialog').close(); assert.equal(h.doc.activeElement, next);
});

test('repeated more retains all old cards, keeps numbering and stops exactly at the catalog end', () => {
  const h = setup(); let old = h.covers(); let pages = 0;
  while (!h.get('load-more').hidden) {
    h.more(); pages++; const current = h.covers();
    for (let i = 0; i < old.length; i++) assert.equal(current[i] === old[i], true);
    assert.equal(h.doc.activeElement, current[old.length]);
    assert.equal(new Set(ids(h)).size, current.length); old = current;
    assert(pages < 20, 'pagination must terminate');
  }
  assert.equal(old.length, Number.parseInt(h.get('result-count').textContent));
  assert.deepEqual(h.get('grid').children.map(e => Number(e.number)), Array.from({length: old.length}, (_, i) => i + 1));
  assert.equal(h.get('grid').replacements, 1); assert.equal(h.get('grid').appends, pages);
});

test('filter changes replace prior cards, reset to the first page and allow fresh append without duplicates', () => {
  const h = setup(); h.more(); const old = h.covers()[0]; h.filter('type', '镜面');
  assert.equal(h.covers().length, Math.min(24, Number.parseInt(h.get('result-count').textContent)));
  assert.equal(old.isConnected, false); const filtered = h.covers();
  if (!h.get('load-more').hidden) { h.more(); assert.equal(h.covers()[0] === filtered[0], true); }
  assert.equal(new Set(ids(h)).size, h.covers().length);
  h.get('reset').fire('click'); assert.equal(h.covers().length, 24); h.more(); assert.equal(h.covers().length, 48);
});

test('unchanged chart and playlist round trips preserve the appended page and its covers', () => {
  const h = setup(); h.more(); const old = h.covers()[0];
  for (const view of ['chart', 'playlists']) { h.nav(view); h.nav('library'); assert.equal(h.covers().length, 48); assert.equal(h.covers()[0] === old, true); }
  h.more(); assert.equal(h.covers().length, 72); assert.equal(h.covers()[0] === old, true); assert.equal(new Set(ids(h)).size, 72);
});

test('a query changed in chart resets the library instead of appending mismatched songs', () => {
  const h = setup(); h.more(); const old = h.covers()[0]; h.nav('chart'); h.input('BTS'); h.nav('library');
  assert.equal(old.isConnected, false); assert.equal(h.covers().length, Math.min(24, Number.parseInt(h.get('result-count').textContent)));
  const expected = setup(); expected.input('BTS'); assert.deepEqual(ids(h), ids(expected)); assert.equal(new Set(ids(h)).size, h.covers().length);
});

test('empty search followed by clear starts a fresh page and can append again', () => {
  const h = setup(); h.more(); h.input('no match impossible 847329');
  assert.equal(h.covers().length, 0); assert.equal(h.get('load-more').hidden, true);
  h.get('empty-reset').fire('click'); assert.equal(h.covers().length, 24); h.more();
  assert.equal(h.covers().length, 48); assert.equal(new Set(ids(h)).size, 48);
});

test('popstate with changed filters resets pagination and does not retain stale cover nodes', () => {
  const h = setup(); h.more(); const old = h.covers()[0];
  h.ctx.location.search = '?q=BTS'; h.ctx.window.fire('popstate');
  assert.equal(old.isConnected, false); const expected = setup(); expected.input('BTS'); assert.deepEqual(ids(h), ids(expected));
  assert.equal(h.covers().length, Math.min(24, Number.parseInt(h.get('result-count').textContent)));
});
