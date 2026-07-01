/**
 * Tests: behavior when DEFAULT_DIRS path does not exist (fresh install on another Mac).
 * Run: node tests/missing-default-dir.test.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_DIRS = [];
const SKIP_DIRS = new Set(['node_modules', '.git', '.DS_Store', '.svn', '.hg']);

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

async function scanDirRecursive(dirPath, rootPath, folders) {
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true, encoding: 'utf8' });
  } catch { return; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);
    try {
      const files = await fs.promises.readdir(fullPath, { encoding: 'utf8' });
      if (files.includes('index.php')) {
        folders.push({ name: entry.name, dir: rootPath, relativePath: path.relative(rootPath, fullPath) });
      } else {
        await scanDirRecursive(fullPath, rootPath, folders);
      }
    } catch { continue; }
  }
}

async function scanDir(rootPath) {
  const folders = [];
  try {
    const files = await fs.promises.readdir(rootPath, { encoding: 'utf8' });
    if (files.includes('index.php')) {
      folders.push({ name: path.basename(rootPath), dir: rootPath, relativePath: '' });
    }
  } catch { /* ignore */ }
  await scanDirRecursive(rootPath, rootPath, folders);
  return folders;
}

async function scanFolders(directories) {
  let all = [];
  for (const dir of directories) {
    const folders = await scanDir(dir);
    all = all.concat(folders);
  }
  return all;
}

function loadConfigFromFile(configPath) {
  let config = { directories: DEFAULT_DIRS, bookmarks: [], recents: [] };
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (!Array.isArray(config.directories) || config.directories.length === 0) {
        config.directories = DEFAULT_DIRS;
      }
    }
  } catch {
    config = { directories: DEFAULT_DIRS, bookmarks: [], recents: [] };
  }
  return config;
}

function startPhpServerCheck(rootDir, directories) {
  const root = rootDir || directories[0];
  if (!root || !fs.existsSync(root)) {
    const msg = !root ? 'Добавьте директорию с лендингами' : 'Директория не найдена';
    return { ok: false, error: msg };
  }
  return { ok: true };
}

function removeDirectory(directories, dir) {
  return directories.filter(d => d !== dir);
}

async function withTempDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phpbrauzer-test-'));
  try {
    await fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function run() {
  console.log('\n=== 1. Fresh install (no config.json) ===');
  await withTempDir(async (tmp) => {
    const configPath = path.join(tmp, 'config.json');
    const config = loadConfigFromFile(configPath);
    assert(config.directories.length === 0, 'uses empty DEFAULT_DIRS when no config');
    const php = startPhpServerCheck(null, config.directories);
    assert(!php.ok && php.error === 'Добавьте директорию с лендингами', 'no PHP without configured dir');
    const folders = await scanFolders(config.directories);
    assert(folders.length === 0, 'no folders without configured dir');
  });

  console.log('\n=== 2. Config with only missing path ===');
  await withTempDir(async (tmp) => {
    const missing = path.join(tmp, 'nonexistent-lander');
    const configPath = path.join(tmp, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ directories: [missing] }));
    const config = loadConfigFromFile(configPath);
    assert(config.directories[0] === missing, 'loads user config path');
    assert(!fs.existsSync(missing), 'test path is missing');
    const php = startPhpServerCheck(null, config.directories);
    assert(!php.ok, 'PHP server does not start');
    const folders = await scanFolders(config.directories);
    assert(folders.length === 0, 'no folders from missing dir');
  });

  console.log('\n=== 3. Mixed: one valid, one missing ===');
  await withTempDir(async (tmp) => {
    const validRoot = path.join(tmp, 'valid');
    const landing = path.join(validRoot, 'TestLanding');
    fs.mkdirSync(landing, { recursive: true });
    fs.writeFileSync(path.join(landing, 'index.php'), '<?php echo "ok";');
    const missing = path.join(tmp, 'gone');
    const folders = await scanFolders([validRoot, missing]);
    assert(folders.length === 1, 'finds landing in valid dir only', `count=${folders.length}`);
    assert(folders[0].name === 'TestLanding', 'correct landing name');
    const phpValid = startPhpServerCheck(validRoot, [validRoot, missing]);
    const phpMissing = startPhpServerCheck(missing, [missing]);
    assert(phpValid.ok, 'can start PHP on valid root');
    assert(!phpMissing.ok, 'cannot start PHP on missing root');
  });

  console.log('\n=== 4. remove-directory (no fallback to missing path) ===');
  const afterRemove = removeDirectory(['/tmp/my-only-dir'], '/tmp/my-only-dir');
  assert(afterRemove.length === 0, 'removing last dir leaves empty list');

  console.log('\n=== 5. Empty directories array in config → DEFAULT_DIRS ===');
  await withTempDir(async (tmp) => {
    const configPath = path.join(tmp, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ directories: [] }));
    const config = loadConfigFromFile(configPath);
    assert(config.directories.length === 0, 'empty array stays empty (no hardcoded fallback');
  });

  console.log('\n=== 6. Corrupt config.json ===');
  await withTempDir(async (tmp) => {
    const configPath = path.join(tmp, 'config.json');
    fs.writeFileSync(configPath, '{ broken json');
    const config = loadConfigFromFile(configPath);
    assert(config.directories.length === 0, 'corrupt config falls back to empty DEFAULT_DIRS');
  });

  console.log('\n=== 7. Path traversal protection (landingPhpPath logic) ===');
  function normalizeLandingRelFile(relativeFile) {
    const norm = path.normalize(relativeFile || 'index.php').replace(/\\/g, '/');
    if (norm.startsWith('..') || path.isAbsolute(norm)) return null;
    return norm;
  }
  function landingPhpPath(folder, relativeFile) {
    const rel = normalizeLandingRelFile(relativeFile);
    if (!rel || !rel.endsWith('.php')) return null;
    const root = path.join(folder.dir, folder.relativePath || '');
    const full = path.join(root, rel);
    if (!full.startsWith(root + path.sep) && full !== root) return null;
    return full;
  }
  const folder = { dir: '/tmp', relativePath: 'landing' };
  assert(landingPhpPath(folder, '../secret.php') === null, 'blocks .. traversal');
  assert(landingPhpPath(folder, 'index.php') !== null, 'allows index.php');
  assert(landingPhpPath(folder, 'config.php') !== null, 'allows config.php');

  console.log('\n=== 8. Legacy path /Volumes/Arbitration/lander (if present) ===');
  const legacyPath = '/Volumes/Arbitration/lander';
  const defaultExists = fs.existsSync(legacyPath);
  console.log(`    ${legacyPath} exists: ${defaultExists}`);
  if (defaultExists) {
    const folders = await scanFolders([legacyPath]);
    console.log(`    landings found: ${folders.length}`);
    assert(folders.length >= 0, 'scan completes without throw');
  } else {
    console.log('    Simulating "other computer" — no dirs configured');
    const php = startPhpServerCheck(null, []);
    assert(!php.ok && php.error === 'Добавьте директорию с лендингами', 'friendly message, no crash');
    const folders = await scanFolders([]);
    assert(folders.length === 0, 'empty sidebar, no crash');
  }

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
