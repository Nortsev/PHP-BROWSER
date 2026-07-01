/**
 * Run: node tests/prune-stale-config.test.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function assert(condition, name, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
  }
}

function isExistingDirectory(dirPath) {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function folderExistsOnDisk(folder) {
  if (!folder?.dir) return false;
  try {
    if (!isExistingDirectory(folder.dir)) return false;
    const lp = path.join(folder.dir, folder.relativePath || '');
    return fs.existsSync(lp) && fs.statSync(lp).isDirectory();
  } catch {
    return false;
  }
}

function pruneConfig(config) {
  const removed = { directories: 0, recents: 0, bookmarks: 0 };

  const nextDirs = config.directories.filter((d) => isExistingDirectory(d));
  removed.directories = config.directories.length - nextDirs.length;
  config.directories = nextDirs;

  const nextRecents = config.recents.filter((f) => folderExistsOnDisk(f));
  removed.recents = config.recents.length - nextRecents.length;
  config.recents = nextRecents;

  const nextBookmarks = config.bookmarks.filter((f) => folderExistsOnDisk(f));
  removed.bookmarks = config.bookmarks.length - nextBookmarks.length;
  config.bookmarks = nextBookmarks;

  const changed = removed.directories + removed.recents + removed.bookmarks > 0;
  return { config, changed, removed };
}

async function withTempDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phpbrauzer-prune-'));
  try {
    await fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function run() {
  console.log('\n=== 1. Remove missing root directory ===');
  await withTempDir(async (tmp) => {
    const missing = path.join(tmp, 'gone');
    const config = {
      directories: [missing],
      recents: [{ dir: missing, relativePath: 'A', name: 'A' }],
      bookmarks: [{ dir: missing, relativePath: 'B', name: 'B' }],
    };
    const { changed, removed, config: next } = pruneConfig(config);
    assert(changed, 'detected stale entries');
    assert(removed.directories === 1, 'removed 1 directory');
    assert(removed.recents === 1, 'removed 1 recent');
    assert(removed.bookmarks === 1, 'removed 1 bookmark');
    assert(next.directories.length === 0, 'directories empty');
  });

  console.log('\n=== 2. Keep valid, drop missing landing only ===');
  await withTempDir(async (tmp) => {
    const root = path.join(tmp, 'lander');
    const landing = path.join(root, 'Good');
    fs.mkdirSync(landing, { recursive: true });
    fs.writeFileSync(path.join(landing, 'index.php'), '<?php');
    const config = {
      directories: [root],
      recents: [
        { dir: root, relativePath: 'Good', name: 'Good' },
        { dir: root, relativePath: 'Deleted', name: 'Deleted' },
      ],
      bookmarks: [],
    };
    const { removed, config: next } = pruneConfig(config);
    assert(removed.directories === 0, 'keeps root directory');
    assert(removed.recents === 1, 'removes missing landing from recents');
    assert(next.recents.length === 1, 'keeps valid recent');
    assert(next.recents[0].name === 'Good', 'correct recent kept');
  });

  console.log('\n=== 3. Unplugged volume path ===');
  const fakeVolume = '/Volumes/DefinitelyMissingVolume_' + Date.now();
  assert(!fs.existsSync(fakeVolume), 'fake volume absent');
  const config = {
    directories: [fakeVolume],
    recents: [],
    bookmarks: [],
  };
  const { removed, config: next } = pruneConfig(config);
  assert(removed.directories === 1, 'removes unplugged volume path');
  assert(next.directories.length === 0, 'config clean');

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
