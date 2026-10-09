'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const { validateCatalog, parseCatalog, loadLegacyBaseline, isSupportedRaster } = require('../scripts/validate-cover-readiness.cjs');
const STATIC_ROOT = path.resolve(__dirname, existsSync(path.resolve(__dirname, '../dist')) ? '../dist' : '..');

const video = (overrides = {}) => ({
  artist: 'New Artist', song: 'New Song', title: 'New Song dance practice',
  platform: 'YouTube', url: 'https://www.youtube.com/watch?v=dyFGwGFerAc',
  sourceEvidenceUrl: 'https://www.youtube.com/watch?v=dyFGwGFerAc',
  ...overrides,
});
const baseline = { schemaVersion: 1, songIds: [], sources: [] };

async function fixture(t) {
  const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eightcount-cover-test-'));
  t.after(() => fs.rm(distDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(distDir, 'assets'));
  await fs.copyFile(path.join(STATIC_ROOT, 'app.js'), path.join(distDir, 'app.js'));
  await sharp({ create: { width: 24, height: 16, channels: 3, background: '#345678' } })
    .png().toFile(path.join(distDir, 'assets', 'cover.png'));
  const covered = video({
    thumbnail: 'assets/cover.png',
    thumbnailSourceUrl: 'https://www.youtube.com/watch?v=dyFGwGFerAc',
    thumbnailProvenance: 'Test fixture provenance declaration, not a real catalog cover.',
  });
  const run = (videos, options = {}) => validateCatalog({
    catalog: { videos }, distDir, baseline, ...options,
  });
  return { distDir, covered, run };
}

test('a new song with no local cover fails both song and new-source readiness', async t => {
  const { run } = await fixture(t);
  const result = await run([video()]);
  assert.equal(result.ok, false);
  assert(result.errors.some(e => e.code === 'SONG_COVER_REQUIRED'));
  assert(result.errors.some(e => e.code === 'SOURCE_COVER_REQUIRED'));
});

test('the exact current 爱你 screenshot field contract passes with a decodable local file', async t => {
  const { covered, run } = await fixture(t);
  const url = 'https://www.bilibili.com/video/BV1gS4y1q7VE/';
  const result = await run([{ ...covered, song: '爱你', artist: '王心凌', url,
    sourceEvidenceUrl: url, thumbnailSourceUrl: url,
    thumbnailProvenance: '2026-10-09：逐条打开原视频页面，核对标题及UP主，截图已暂停的真实播放器画面（00:17）；裁去黑边，非生成图。',
  }]);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.summary.coveredSongs, 1);
  assert.equal(result.summary.readySources, 1);
});

test('legacy localThumbnail, imageSource and imageKind declarations remain supported', async t => {
  const { run } = await fixture(t);
  const result = await run([video({ localThumbnail: 'assets/cover.png',
    imageSource: 'https://weverse.io/i-dle/media/1-140652006',
    imageKind: 'Official source-page thumbnail declared to match this video',
  })]);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.summary.readySources, 1);
});

test('old missing covers are grandfathered without allowing a new uncovered source on the same song', async t => {
  const { run } = await fixture(t);
  const old = video();
  const legacy = { schemaVersion: 1, songIds: ['newartist-newsong'], sources: [{ songId: 'newartist-newsong', url: old.url }] };
  const transition = await run([old], { baseline: legacy });
  assert.equal(transition.ok, true);
  assert.equal(transition.summary.legacyUncoveredSongs, 1);
  const added = await run([old, video({ url: 'https://www.youtube.com/watch?v=pKCaXYYwGjw' })], { baseline: legacy });
  assert.equal(added.ok, false);
  assert(added.errors.some(e => e.code === 'SOURCE_COVER_REQUIRED' && e.url.endsWith('pKCaXYYwGjw')));
});

test('strict mode requires one valid cover per legacy song, not one per legacy source', async t => {
  const { covered, run } = await fixture(t);
  const other = video({ url: 'https://www.youtube.com/watch?v=pKCaXYYwGjw' });
  const legacy = { schemaVersion: 1, songIds: ['newartist-newsong'], sources: [covered, other].map(v => ({ songId: 'newartist-newsong', url: v.url })) };
  assert.equal((await run([video(), other], { baseline: legacy, strict: true })).ok, false);
  const result = await run([covered, other], { baseline: legacy, strict: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.summary.readySources, 1);
});

test('an existing covered source does not waive the cover requirement for an added source', async t => {
  const { covered, run } = await fixture(t);
  const legacy = { schemaVersion: 1, songIds: ['newartist-newsong'], sources: [{ songId: 'newartist-newsong', url: covered.url }] };
  const result = await run([covered, video({ url: 'https://www.youtube.com/watch?v=pKCaXYYwGjw' })], { baseline: legacy });
  assert.equal(result.ok, false);
  assert.equal(result.errors.filter(e => e.code === 'SOURCE_COVER_REQUIRED').length, 1);
});

test('old URLs cannot be reassigned to new songs to inherit the transition exemption', async t => {
  const { run } = await fixture(t);
  const legacy = { schemaVersion: 1, songIds: ['oldartist-oldsong'], sources: [{ songId: 'oldartist-oldsong', url: video().url }] };
  const result = await run([video()], { baseline: legacy });
  assert.equal(result.ok, false);
  assert(result.errors.some(e => e.code === 'SOURCE_COVER_REQUIRED'));
  assert(result.errors.some(e => e.code === 'LEGACY_SONG_REMOVED'));
});

test('missing legacy songs and sources cannot be silently deleted to make the gate pass', async t => {
  const { run } = await fixture(t);
  const legacy = { schemaVersion: 1, songIds: ['oldartist-oldsong'], sources: [{ songId: 'oldartist-oldsong', url: video().url }] };
  const result = await run([], { baseline: legacy });
  assert.equal(result.ok, false);
  assert(result.errors.some(e => e.code === 'LEGACY_SONG_REMOVED'));
  assert(result.errors.some(e => e.code === 'LEGACY_SOURCE_REMOVED'));
});

test('remote URLs, absent files, HTML disguised as images and truncated images do not qualify', async t => {
  const { distDir, covered, run } = await fixture(t);
  await fs.writeFile(path.join(distDir, 'assets', 'html.jpg'), '<html>Not a video cover</html>');
  const png = await fs.readFile(path.join(distDir, 'assets', 'cover.png'));
  const truncated = png.subarray(0, png.length - 16);
  assert.equal((await sharp(truncated).metadata()).width, 24, 'Fixture has a readable header but incomplete pixel data');
  await fs.writeFile(path.join(distDir, 'assets', 'truncated.png'), truncated);
  for (const thumbnail of ['https://images.example.test/cover.jpg', 'assets/missing.jpg', 'assets/html.jpg', 'assets/truncated.png']) {
    const result = await run([{ ...covered, thumbnail }]);
    assert.equal(result.ok, false, thumbnail);
    assert.equal(result.summary.readySources, 0, thumbnail);
  }
});

test('unsafe paths and symbolic-link escapes are rejected without reading outside the asset root', async t => {
  const { distDir, covered, run } = await fixture(t);
  const outside = path.join(distDir, 'outside.png');
  await fs.copyFile(path.join(distDir, 'assets', 'cover.png'), outside);
  await fs.symlink(outside, path.join(distDir, 'assets', 'escape.png'));
  for (const thumbnail of ['assets/../outside.png', '/tmp/cover.png', 'assets/%2e%2e/outside.png', 'assets/escape.png', 'assets/./cover.png', 'assets/cover.png?x=1']) {
    assert.equal((await run([{ ...covered, thumbnail }])).ok, false, thumbnail);
  }
});

test('source provenance must be explicit, safe and tied to the precise video URL', async t => {
  const { covered, run } = await fixture(t);
  for (const change of [
    { thumbnailSourceUrl: undefined }, { thumbnailProvenance: ' ' },
    { thumbnailSourceUrl: 'https://www.youtube.com/watch?v=pKCaXYYwGjw' },
    { thumbnailSourceUrl: 'javascript:alert(1)' },
    { sourceEvidenceUrl: undefined },
    { sourceEvidenceUrl: 'http://www.youtube.com/watch?v=dyFGwGFerAc' },
    { sourceEvidenceUrl: 'https://user:secret@www.youtube.com/' },
  ]) {
    assert.equal((await run([{ ...covered, ...change }])).ok, false, JSON.stringify(change));
  }
});

test('unsafe source URLs, invalid song identities and duplicate sources cannot disappear from validation', async t => {
  const { covered, run } = await fixture(t);
  for (const videos of [[{ ...covered, url: 'https://example.test/not-supported' }], [{ ...covered, song: '' }], [covered, covered]]) {
    const result = await run(videos);
    assert.equal(result.ok, false);
    assert(result.errors.some(e => e.code === 'INVALID_SOURCE' || e.code === 'DUPLICATE_SOURCE'));
  }
});

test('malformed catalogs and transition baselines fail closed', async t => {
  const { run } = await fixture(t);
  await assert.rejects(run([], { catalog: {} }), /videos/i);
  await assert.rejects(run([], { baseline: {} }), /baseline/i);
});

test('CLI uses a frozen 298-song, 431-source baseline and returns machine-readable diagnostics', () => {
  const cwd = path.resolve(__dirname, '..');
  const result = spawnSync(process.execPath, ['scripts/validate-cover-readiness.cjs', '--json'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.legacySongs, 298);
  assert.equal(report.summary.legacySources, 431);
  assert(Number.isInteger(report.summary.newSources) && report.summary.newSources >= 0);
  assert.equal(report.mode, 'transition');
  assert.match(report.limitations, /manual|human/i);
});

test('CLI refuses an unavailable decoder and unsupported flags instead of silently passing', async t => {
  const { distDir } = await fixture(t);
  const copiedScript = path.join(distDir, 'validate-cover-readiness.cjs');
  await fs.copyFile(path.resolve(__dirname, '../scripts/validate-cover-readiness.cjs'), copiedScript);
  const missing = spawnSync(process.execPath, [copiedScript], {
    cwd: distDir, encoding: 'utf8', env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
  });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /sharp.*unavailable|cannot.*sharp/i);
  const flags = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/validate-cover-readiness.cjs'), '--update-baseline'], { encoding: 'utf8' });
  assert.equal(flags.status, 2);
  assert.match(flags.stderr, /unknown.*option/i);
});

test('SVG content disguised as a PNG is rejected rather than rasterized and accepted', async t => {
  const { distDir, covered, run } = await fixture(t);
  await fs.writeFile(path.join(distDir, 'assets', 'vector.png'), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16"><rect width="24" height="16" fill="red"/></svg>');
  const result = await run([{ ...covered, thumbnail: 'assets/vector.png' }]);
  assert.equal(result.ok, false);
  assert.equal(result.summary.readySources, 0);
});

test('legacy provenance cannot pass with a missing description or unsafe imageSource', async t => {
  const { run } = await fixture(t);
  for (const fields of [
    { imageSource: 'https://weverse.io/i-dle/media/1-140652006' },
    { imageSource: 'javascript:alert(1)', imageKind: 'Screenshot' },
    { imageSource: 'https://name:secret@example.test/cover', imageKind: 'Screenshot' },
  ]) {
    assert.equal((await run([video({ localThumbnail: 'assets/cover.png', ...fields })])).ok, false);
  }
});

test('catalog parsing reads JSON without executing JavaScript', () => {
  assert.deepEqual(parseCatalog('globalThis.EIGHTCOUNT_DATA = {"videos": []};\n'), { videos: [] });
  assert.deepEqual(parseCatalog('globalThis.EIGHTCOUNT_DATA = {"videos": []}'), { videos: [] });
  assert.throws(() => parseCatalog('globalThis.EIGHTCOUNT_DATA = {"videos": []}; globalThis.eightcountExecuted = true;'));
  assert.throws(() => parseCatalog('console.log("not catalog JSON")'));
  assert.equal(globalThis.eightcountExecuted, undefined);
});

test('the baseline is pinned and adding a later song to the JSON exemption list fails closed', async t => {
  const original = await loadLegacyBaseline();
  assert.equal(original.songIds.length, 298);
  assert.equal(original.sources.length, 431);
  const { distDir } = await fixture(t);
  const copiedScript = path.join(distDir, 'validate-cover-readiness.cjs');
  await fs.copyFile(path.resolve(__dirname, '../scripts/validate-cover-readiness.cjs'), copiedScript);
  original.songIds.push('unapproved-new-song');
  await fs.writeFile(path.join(distDir, 'cover-readiness-legacy.json'), JSON.stringify(original));
  const result = spawnSync(process.execPath, [copiedScript], { cwd: distDir, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /frozen legacy baseline was changed/i);
});

test('CLI works in a published root layout and an explicitly selected static directory', async t => {
  const { distDir: root, covered } = await fixture(t);
  await fs.mkdir(path.join(root, 'scripts'));
  for (const name of ['validate-cover-readiness.cjs', 'cover-readiness-legacy.json']) {
    await fs.copyFile(path.resolve(__dirname, '../scripts', name), path.join(root, 'scripts', name));
  }
  const catalog = parseCatalog(await fs.readFile(path.join(STATIC_ROOT, 'catalog.js'), 'utf8'));
  const legacyUrls = new Set((await loadLegacyBaseline()).sources.map(source => source.url));
  // Isolate this layout fixture from future live additions, which the live CLI test checks separately.
  catalog.videos = catalog.videos.filter(source => legacyUrls.has(source.url));
  const url = 'https://www.youtube.com/watch?v=AbCdEfGhI01';
  catalog.videos.push({ ...covered, url, thumbnailSourceUrl: url, sourceEvidenceUrl: url });
  await fs.writeFile(path.join(root, 'catalog.js'), `globalThis.EIGHTCOUNT_DATA = ${JSON.stringify(catalog)};`);
  const script = path.join(root, 'scripts/validate-cover-readiness.cjs');
  const implicit = spawnSync(process.execPath, [script, '--json'], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(implicit.status, 0, implicit.stderr || implicit.stdout);
  assert.equal(JSON.parse(implicit.stdout).summary.newSources, 1);
  const selected = path.join(root, 'published-static');
  await fs.mkdir(selected);
  for (const name of ['app.js', 'catalog.js', 'assets']) await fs.rename(path.join(root, name), path.join(selected, name));
  const explicit = spawnSync(process.execPath, [script, '--dist-root', 'published-static', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(explicit.status, 0, explicit.stderr || explicit.stdout);
  assert.equal(JSON.parse(explicit.stdout).summary.newSources, 1);
});

test('CLI rejects --dist-root with no value rather than selecting an unintended directory', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/validate-cover-readiness.cjs'), '--dist-root'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--dist-root.*requires.*path/i);
});

test('HEIF containers qualify only for AV1/AVIF, not HEIC or an unspecified compression', () => {
  assert.equal(isSupportedRaster({ format: 'heif', compression: 'av1' }), true);
  assert.equal(isSupportedRaster({ format: 'heif', compression: 'hevc' }), false);
  assert.equal(isSupportedRaster({ format: 'heif' }), false);
});
