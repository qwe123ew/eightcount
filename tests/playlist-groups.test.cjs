'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Published copies keep static assets at the root, while the source uses dist/.
const staticRoot = [path.resolve(__dirname, '../dist'), path.resolve(__dirname, '..')]
  .find(root => ['app.js', 'catalog.js', 'index.html'].every(file => fs.existsSync(path.join(root, file))));
assert(staticRoot, 'the source or published static assets must exist beside the tests');
const index = fs.readFileSync(path.join(staticRoot, 'index.html'), 'utf8');
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

// This exercises application rendering and navigation, not real browser layout.
function setup({ playlists, search = '' } = {}) {
  class Element {
    constructor() { this.listeners = {}; this.innerHTML = ''; this.value = ''; this.firstChild = {}; this.isConnected = true; }
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
    fire(name, event = {}) { for (const listener of this.listeners[name] || []) listener(event); }
    querySelectorAll() { return []; }
    setAttribute(name, value) { this[name] = value; }
    focus(options) { this.focused = true; this.focusOptions = options; }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire('close'); }
  }
  const elements = new Map([...index.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const get = id => elements.get(id) || null;
  const document = new Element();
  document.getElementById = get;
  document.querySelectorAll = () => [];
  document.querySelector = () => null;
  const context = {
    document, window: new Element(), location: { search, href: `https://example.test/${search}` },
    history: {
      entries: [],
      replaceState(state, title, url) { this.current = String(url); },
      pushState(state, title, url) { this.entries.push(String(url)); this.current = String(url); }
    },
    URL, URLSearchParams, CSS: { escape: value => value }, AbortController
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(staticRoot, 'catalog.js'), 'utf8'), context);
  if (playlists) context.EIGHTCOUNT_DATA.playlists = playlists;
  const before = JSON.stringify(context.EIGHTCOUNT_DATA);
  vm.runInContext(fs.readFileSync(path.join(staticRoot, 'app.js'), 'utf8'), context);
  const click = (selector, node) => document.fire('click', { target: { closest: value => value === selector ? node : null } });
  const nav = view => click('button[data-view]', { dataset: { view } });
  return { context, get, click, nav, before };
}

function renderedGroups(html) {
  return [...html.matchAll(/<section class="playlist-group"[\s\S]*?<\/section>/g)].map(match => match[0]);
}

test('playlist view removes the selection control and keeps the song-list mount', () => {
  const panel = index.match(/<details id="imported-playlists"[\s\S]*?<\/details>/)[0];
  assert.doesNotMatch(panel, /<select\b|选择歌单|playlist-select/);
  assert.match(panel, /id="playlist-tracks"/);
});

test('both imported playlists render every original row in separately labelled groups', () => {
  const h = setup({ search: '?view=playlists' });
  const lists = h.context.EIGHTCOUNT_DATA.playlists;
  const sections = renderedGroups(h.get('playlist-tracks').innerHTML);
  assert.equal(sections.length, 2, 'each imported playlist must remain reachable without a selector');
  assert.equal(h.get('imported-playlists').hidden, false);
  assert.equal(h.get('imported-playlists').open, true);
  assert.equal(h.get('playlist-summary').textContent, '2 份 · 64 条歌单记录');
  for (const [i, list] of lists.entries()) {
    const section = sections[i];
    assert.match(section, new RegExp(`aria-labelledby="playlist-heading-${i}"`));
    assert(section.includes(`<h2 id="playlist-heading-${i}" class="playlist-heading">${escapeHTML(list.title)}</h2>`));
    assert(section.includes(escapeHTML(list.note)));
    assert.equal((section.match(/class="playlist-track"/g) || []).length, list.tracks.length);
    assert.deepEqual([...section.matchAll(/class="playlist-number">(.*?)<\/span>/g)].map(match => match[1]), Array.from(list.tracks, track => String(track.index)));
    assert.deepEqual([...section.matchAll(/data-query="[^"]*">(.*?)<\/button>/g)].map(match => match[1]), Array.from(list.tracks, track => escapeHTML(track.song)));
  }
  assert.match(sections[1], /第27—29条未显示/);
  assert.match(sections[1], /3am/);
  assert.match(sections[1], /待补舞蹈来源/);
  assert.equal(JSON.stringify(h.context.EIGHTCOUNT_DATA), h.before, 'rendering cannot change any saved records or videos');
});

test('group titles and notes escape markup while retaining duplicate and unresolved rows', () => {
  const playlists = [
    { id: 'one', title: 'First <script>', note: 'Note <img onerror="bad"> & more', tracks: [
      { index: 1, song: 'Dynamite', artist: 'BTS' }, { index: 2, song: 'Dynamite', artist: 'BTS' }
    ] },
    { id: 'two', title: 'Second & playlist', note: 'Only 2 of 3 imported', tracks: [
      { index: 1, song: 'Unknown <song>', artist: 'Unknown' },
      { index: 2, song: 'Dynamite (Remix)', artist: 'BTS', matchSong: 'Dynamite', exactMatch: false, versionNote: '<Remix> needs checking' }
    ] }
  ];
  const h = setup({ playlists });
  const sections = renderedGroups(h.get('playlist-tracks').innerHTML);
  assert.equal(sections.length, 2);
  assert.match(sections[0], /First &lt;script&gt;/);
  assert.match(sections[0], /Note &lt;img onerror=&quot;bad&quot;&gt; &amp; more/);
  assert.equal((sections[0].match(/data-query="BTS Dynamite"/g) || []).length, 2);
  assert.match(sections[1], /Unknown &lt;song&gt;/);
  assert.match(sections[1], /待补舞蹈来源/);
  assert.match(sections[1], /版本待核对/);
  assert.match(sections[1], /&lt;Remix&gt; needs checking/);
  assert.doesNotMatch(h.get('playlist-tracks').innerHTML, /<script|<img/);
  assert.equal(JSON.stringify(h.context.EIGHTCOUNT_DATA), h.before);
});

test('a song from the second playlist opens catalog results and Back restores both groups', () => {
  const h = setup(); h.nav('playlists');
  const html = h.get('playlist-tracks').innerHTML;
  const sections = renderedGroups(html);
  assert.equal(sections.length, 2);
  const query = sections[1].match(/data-query="([^"]+)"/)[1];
  h.click('[data-query]', { dataset: { query }, closest: selector => selector === '.playlist-track' ? {} : null });
  assert.equal(h.get('library-panel').hidden, false);
  assert.equal(h.get('imported-playlists').hidden, true);
  assert.equal(h.get('search').value, query);
  assert.match(h.get('grid').innerHTML, /class="track-card"/);
  assert.equal(h.context.history.entries.length, 2);
  assert.equal(new URL(h.context.history.entries[0]).searchParams.get('view'), 'playlists');
  assert.equal(new URL(h.context.history.entries[1]).searchParams.get('q'), query);
  h.context.location.search = '?view=playlists';
  h.context.window.fire('popstate');
  assert.equal(h.get('imported-playlists').hidden, false);
  assert.equal(h.get('imported-playlists').open, true);
  assert.equal(h.get('playlist-tracks').innerHTML, html);
});

test('an empty imported-playlist collection does not need a selector to initialize', () => {
  const h = setup({ playlists: [] });
  h.nav('playlists');
  assert.equal(h.get('playlist-tracks').innerHTML, '');
  assert.equal(h.get('library-panel').hidden, true);
  assert.equal(h.get('imported-playlists').hidden, false);
});
