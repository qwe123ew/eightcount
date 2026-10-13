'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '..');
const staticRoot = fs.existsSync(path.join(repoRoot, 'dist', 'style.css')) ? path.join(repoRoot, 'dist') : repoRoot;
const css = fs.readFileSync(path.join(staticRoot, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Authored CSS contracts only: these do not simulate the cascade, render boxes,
// or replace the separate narrow-browser checks for wrapping and tap geometry.
function media(condition) {
  let output = '';
  let cursor = 0;
  const marker = `@media (${condition})`;
  while ((cursor = css.indexOf(marker, cursor)) !== -1) {
    const start = css.indexOf('{', cursor);
    let depth = 1;
    let end = start + 1;
    for (; end < css.length && depth; end++) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}') depth--;
    }
    assert.equal(depth, 0, `Unclosed ${marker}`);
    output += css.slice(start + 1, end - 1) + '\n';
    cursor = end;
  }
  assert(output, `Missing ${marker}`);
  return output;
}

function declarations(selector, source = css) {
  const result = {};
  for (const [, selectors, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').some(value => value.trim() === selector)) continue;
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon !== -1) result[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  return result;
}

test('playlist groups have distinct headings and separated sections', () => {
  const heading = declarations('.playlist-heading');
  assert.equal(heading['font-size'], '18px');
  assert.equal(heading['line-height'], '1.4');
  const separation = declarations('.playlist-group + .playlist-group');
  assert.equal(separation['margin-block-start'], '24px');
  assert.equal(separation['padding-block-start'], '24px');
  assert.equal(separation['border-top'], '1px solid var(--edge)');
});

test('playlist headings, notes and song text can wrap without clipping content', () => {
  for (const selector of ['.playlist-heading', '.playlist-note', '.playlist-track button', '.playlist-track p']) {
    const rule = declarations(selector);
    assert.equal(rule['overflow-wrap'], 'anywhere', selector);
    assert.notEqual(rule['white-space'], 'nowrap', selector);
    assert.notEqual(rule.overflow, 'hidden', selector);
    assert.notEqual(rule.display, 'none', selector);
    assert.equal(rule['-webkit-line-clamp'], undefined, selector);
  }
  assert.equal(declarations('.playlist-track > div')['min-width'], '0');
});

test('mobile song-title buttons fill their content column and provide 44px targets', () => {
  const mobile = media('max-width: 760px');
  for (const selector of ['.song-title', '.chart-track > div > button', '.playlist-track button']) {
    const rule = declarations(selector, mobile);
    assert.equal(rule.width, '100%', selector);
    assert.equal(rule['min-width'], '44px', selector);
    assert.equal(rule['min-height'], '44px', selector);
  }
});

test('small mobile navigation and filter controls retain at least 44px targets', () => {
  const mobile = media('max-width: 760px');
  for (const selector of ['.text-button', '.filter-top .text-button', '.view-nav button', '.quick-row button',
    '#domestic-toggle', '.filter-option', '.filter-chip', '.clear-filters', '.chart-open',
    '.external-links a', '.verification-details summary']) {
    const rule = declarations(selector, mobile);
    assert.equal(rule['min-width'], '44px', selector);
    assert.equal(rule['min-height'], '44px', selector);
  }
});

test('mobile reset has horizontal breathing room as well as minimum dimensions', () => {
  const mobile = media('max-width: 760px');
  assert.equal(declarations('.filter-top .text-button', mobile)['padding-inline'], '8px');
});

test('compact mobile playlist spacing offsets larger targets without hiding metadata', () => {
  const mobile = media('max-width: 760px');
  assert.equal(declarations('.playlist-track', mobile).padding, '8px 12px');
  assert.equal(declarations('.playlist-track p', mobile).margin, '2px 0 0');
  assert.equal(declarations('.playlist-track', media('max-width: 420px')).gap, '0 9px');
  assert.equal(declarations('.playlist-badge', media('max-width: 420px'))['grid-column'], '2');
  for (const selector of ['.playlist-track p', '.playlist-track .playlist-version', '.playlist-badge']) {
    const rule = declarations(selector);
    assert.notEqual(rule.display, 'none', selector);
    assert.notEqual(rule.overflow, 'hidden', selector);
  }
});
