'use strict';

const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// One-time migration snapshot, intentionally not regenerated from the live catalog.
const BASELINE_SHA256 = '640c061118250eee1dc0c0e7ed96aee77da10211366ac099c743482ab9d1a0a5';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const LIMITATIONS = 'This gate proves local file decoding and declared source-mapping consistency only. Human/manual review of the actual image against the exact video and its evidence is still required; it does not certify authenticity, content, copyright or playback availability.';

function loadSharp() {
  try {
    return require('sharp');
  } catch (error) {
    throw new Error(`Image decoder sharp is unavailable; cover validation cannot complete. Make sharp available through normal Node module resolution, then rerun. ${error.message}`);
  }
}

function isHttps(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function pairKey(songId, url) {
  return JSON.stringify([songId, url]);
}

function checkBaseline(baseline) {
  if (!baseline || baseline.schemaVersion !== 1 || !Array.isArray(baseline.songIds) ||
      !Array.isArray(baseline.sources) || baseline.songIds.some(id => !nonempty(id))) {
    throw new Error('Invalid legacy baseline schema. Validation cannot complete.');
  }
  const songs = new Set(baseline.songIds);
  const pairs = new Set();
  for (const source of baseline.sources) {
    if (!source || !songs.has(source.songId) || !isHttps(source.url)) {
      throw new Error('Invalid legacy baseline source mapping.');
    }
    pairs.add(pairKey(source.songId, source.url));
  }
  if (songs.size !== baseline.songIds.length || pairs.size !== baseline.sources.length) {
    throw new Error('Duplicate legacy baseline entries.');
  }
  return { songs, pairs };
}

async function loadLegacyBaseline() {
  const bytes = await fs.readFile(path.join(__dirname, 'cover-readiness-legacy.json'));
  if (createHash('sha256').update(bytes).digest('hex') !== BASELINE_SHA256) {
    throw new Error('Frozen legacy baseline was changed. Do not whitelist later catalog additions or regenerate this file.');
  }
  const baseline = JSON.parse(bytes);
  checkBaseline(baseline);
  if (baseline.songIds.length !== 298 || baseline.sources.length !== 431) {
    throw new Error('Frozen legacy baseline must contain exactly 298 songs and 431 sources.');
  }
  return baseline;
}

function parseCatalog(text) {
  const match = text.match(/^\s*globalThis\.EIGHTCOUNT_DATA\s*=\s*([\s\S]*?)\s*;?\s*$/);
  if (!match) throw new Error('Expected catalog.js to assign a JSON object to globalThis.EIGHTCOUNT_DATA.');
  // Parse data only: never execute a catalog file as JavaScript.
  return JSON.parse(match[1]);
}

function isSupportedRaster(metadata) {
  return ['jpeg', 'png', 'webp', 'gif'].includes(metadata.format) ||
    (metadata.format === 'heif' && metadata.compression === 'av1');
}

async function inspectFile(filename, distDir, sharp) {
  if (typeof filename !== 'string' ||
      !/^assets\/[a-zA-Z0-9_./-]+\.(?:avif|gif|jpe?g|png|webp)$/i.test(filename) ||
      filename.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Cover must be a safe local assets/ raster-image path, with no traversal, URL or query string.');
  }
  const root = await fs.realpath(distDir);
  const file = await fs.realpath(path.join(root, filename));
  if (!file.startsWith(path.join(root, 'assets') + path.sep)) {
    throw new Error('Cover symlink resolves outside the dist/assets directory.');
  }
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > 20 * 1024 * 1024) {
    throw new Error('Cover must be a nonempty regular file no larger than 20 MiB.');
  }
  const bytes = await fs.readFile(file);
  const metadata = await sharp(bytes, { failOn: 'warning', limitInputPixels: 40_000_000 }).metadata();
  if (!isSupportedRaster(metadata)) {
    throw new Error('Cover bytes must contain a supported raster image; SVG and other formats do not qualify.');
  }
  // Decode pixel data, not just the header. Fail closed on corruption warnings.
  const { info } = await sharp(bytes, { failOn: 'warning', limitInputPixels: 40_000_000 })
    .raw().toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height) throw new Error('Decoded image has no pixels.');
  return { path: filename, width: info.width, height: info.height,
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function provenanceError(video, field) {
  if (!isHttps(video.sourceEvidenceUrl)) return 'sourceEvidenceUrl must be a credential-free HTTPS evidence URL.';
  if (video.thumbnailSourceUrl != null && video.thumbnailSourceUrl !== video.url) {
    return 'thumbnailSourceUrl must match this exact video URL, including its version/page query.';
  }
  if (video.thumbnailSourceUrl === video.url && nonempty(video.thumbnailProvenance)) return null;
  if (field === 'localThumbnail' && isHttps(video.imageSource) && nonempty(video.imageKind)) return null;
  return 'Missing provenance: provide exact thumbnailSourceUrl + thumbnailProvenance, or localThumbnail + HTTPS imageSource + imageKind.';
}

async function validateCatalog({ catalog, distDir, baseline, strict = false }) {
  const sharp = loadSharp();
  const { normalize, safeURL } = require(path.join(path.resolve(distDir), 'app.js'));
  if (!catalog || !Array.isArray(catalog.videos)) throw new Error('Catalog videos must be an array.');
  const legacy = checkBaseline(baseline);
  const errors = [];
  const sourceResults = [];
  const groups = new Map();
  const currentPairs = new Set();
  const seenUrls = new Set();
  const fileChecks = new Map();

  for (const [index, video] of catalog.videos.entries()) {
    if (!video || !nonempty(video.artist) || !nonempty(video.song) ||
        !normalize(video.artist) || !normalize(video.song) || !safeURL(video.url)) {
      errors.push({ code: 'INVALID_SOURCE', index, message: 'Each source needs a nonempty artist/song identity and an allowed HTTPS video URL.' });
      continue;
    }
    const songId = `${normalize(video.artist)}-${normalize(video.song)}`;
    const key = pairKey(songId, video.url);
    if (seenUrls.has(video.url)) {
      errors.push({ code: 'DUPLICATE_SOURCE', songId, url: video.url, message: 'Duplicate video URL in catalog.' });
    }
    seenUrls.add(video.url);
    currentPairs.add(key);
    if (!groups.has(songId)) groups.set(songId, []);
    const result = { songId, url: video.url, legacy: legacy.pairs.has(key), ready: false, reasons: [] };
    for (const field of ['localThumbnail', 'thumbnail']) {
      if (!video[field]) continue;
      const reason = provenanceError(video, field);
      if (reason) {
        result.reasons.push(`${field}: ${reason}`);
        continue;
      }
      try {
        if (!fileChecks.has(video[field])) {
          // Cache the resolved result, including failure, without an unhandled rejection.
          fileChecks.set(video[field], inspectFile(video[field], distDir, sharp)
            .then(value => ({ value }), error => ({ error })));
        }
        const decoded = await fileChecks.get(video[field]);
        if (decoded.error) throw decoded.error;
        result.cover = { ...decoded.value, field,
          sourceUrl: video.url,
          evidenceUrl: video.thumbnailSourceUrl === video.url && nonempty(video.thumbnailProvenance)
            ? video.thumbnailSourceUrl : video.imageSource };
        result.ready = true;
        break;
      } catch (error) {
        result.reasons.push(`${field}: ${error.message}`);
      }
    }
    if (!result.ready && result.reasons.length === 0) result.reasons.push('No local cover declared.');
    if (!result.legacy && !result.ready) {
      errors.push({ code: 'SOURCE_COVER_REQUIRED', songId, url: video.url,
        message: 'Every newly added video source needs its own decodable local cover and provenance.', reasons: result.reasons });
    }
    groups.get(songId).push(result);
    sourceResults.push(result);
  }

  const uncoveredSongs = [];
  for (const [songId, sources] of groups) {
    if (sources.some(source => source.ready)) continue;
    uncoveredSongs.push(songId);
    if (strict || !legacy.songs.has(songId)) {
      errors.push({ code: 'SONG_COVER_REQUIRED', songId, message: 'Song needs at least one qualifying local video cover.' });
    }
  }
  for (const songId of legacy.songs) {
    if (!groups.has(songId)) errors.push({ code: 'LEGACY_SONG_REMOVED', songId, message: 'Do not delete existing songs to satisfy the cover gate.' });
  }
  for (const source of baseline.sources) {
    if (!currentPairs.has(pairKey(source.songId, source.url))) {
      errors.push({ code: 'LEGACY_SOURCE_REMOVED', ...source, message: 'Existing source was removed or reassigned; migration must preserve the baseline catalog.' });
    }
  }

  return {
    ok: errors.length === 0, mode: strict ? 'strict' : 'transition',
    summary: { songs: groups.size, sources: catalog.videos.length,
      legacySongs: legacy.songs.size, legacySources: legacy.pairs.size,
      newSongs: [...groups.keys()].filter(id => !legacy.songs.has(id)).length,
      newSources: sourceResults.filter(source => !source.legacy).length,
      coveredSongs: groups.size - uncoveredSongs.length,
      readySources: sourceResults.filter(source => source.ready).length,
      legacyUncoveredSongs: uncoveredSongs.filter(id => legacy.songs.has(id)).length },
    errors, uncoveredSongs, sources: sourceResults, limitations: LIMITATIONS,
  };
}

async function main(args) {
  let distDir;
  const options = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dist-root') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--dist-root requires a directory path.');
      distDir = path.resolve(value);
    } else if (['--strict', '--json', '--help'].includes(arg)) options.add(arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.has('--help')) {
    console.log('Usage: node scripts/validate-cover-readiness.cjs [--dist-root PATH] [--strict] [--json]\nStatic root: explicit --dist-root, otherwise project dist/ when present, otherwise project root.\nDefault: new songs and new video sources require local covers; legacy content remains visible.\n--strict: also require at least one qualifying cover for every legacy song.\nNo network access, catalog edits or baseline-update option.');
    return;
  }
  distDir ||= existsSync(path.join(PROJECT_ROOT, 'dist')) ? path.join(PROJECT_ROOT, 'dist') : PROJECT_ROOT;
  loadSharp(); // Check decoding capability even when every current source is legacy.
  const baseline = await loadLegacyBaseline();
  const catalog = parseCatalog(await fs.readFile(path.join(distDir, 'catalog.js'), 'utf8'));
  const result = await validateCatalog({ catalog, distDir, baseline, strict: options.has('--strict') });
  result.staticRoot = distDir;
  if (options.has('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} cover readiness (${result.mode}): ${result.summary.coveredSongs}/${result.summary.songs} songs covered; ${result.summary.readySources}/${result.summary.sources} sources ready.`);
    console.log(`New songs: ${result.summary.newSongs}; new sources: ${result.summary.newSources}; legacy uncovered songs: ${result.summary.legacyUncoveredSongs}.`);
    for (const error of result.errors.slice(0, 10)) console.error(`${error.code} ${error.songId || ''} ${error.url || ''}: ${error.message}${error.reasons ? ' ' + error.reasons.join(' ') : ''}`);
    if (result.errors.length > 10) console.error(`${result.errors.length - 10} further errors; use --json for all diagnostics.`);
    console.log('Manual review required: decoding and declared mapping checks cannot prove visual authenticity.');
  }
  process.exitCode = result.ok ? 0 : 1;
}

module.exports = { validateCatalog, loadLegacyBaseline, parseCatalog, isSupportedRaster };
if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Cover validation could not complete: ${error.message}`);
    process.exitCode = 2;
  });
}
