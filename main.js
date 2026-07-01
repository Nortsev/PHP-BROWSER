const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const pty = require('node-pty');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const EDITOR_HISTORY_DIR = path.join(app.getPath('userData'), 'editor-history');
const DEFAULT_DIRS = [];
const PHP_PORT = 8080;
const VIDEO_MAX_MINUTES = 33;
const VIDEO_TARGET_MB = 90;
const VIDEO_AUDIO_KBPS = 96;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;

function getPhpRouterPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'router.php');
  }
  return path.join(__dirname, 'router.php');
}

let mainWindow = null;
let phpProcess = null;
let ptyProcess = null;
let videoEncodeJob = null;
let config = { directories: DEFAULT_DIRS, bookmarks: [], recents: [] };
let contentSearchCache = { query: '', results: [], at: 0 };
let pendingPruneNotify = null;
const indexContentCache = new Map();

const binaryCache = {};

const BIN_CANDIDATES = {
  php: ['/opt/homebrew/bin/php', '/opt/homebrew/opt/php/bin/php', '/usr/local/bin/php', '/usr/bin/php'],
  ffmpeg: ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'],
  ffprobe: ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'],
};

async function resolveBinary(name) {
  if (binaryCache[name]) return binaryCache[name];

  for (const p of BIN_CANDIDATES[name] || []) {
    if (fs.existsSync(p)) {
      binaryCache[name] = p;
      return p;
    }
  }

  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const found = await new Promise((resolve, reject) => {
      execFile(shell, ['-lc', `command -v ${name}`], (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
    if (found && fs.existsSync(found)) {
      binaryCache[name] = found;
      return found;
    }
  } catch { /* ignore */ }

  return null;
}

function enrichPath(env) {
  const extras = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.mimocode/bin')];
  let pathVal = env.PATH || '';
  const parts = pathVal.split(':').filter(Boolean);
  for (const dir of extras) {
    if (fs.existsSync(dir) && !parts.includes(dir)) parts.unshift(dir);
  }
  env.PATH = parts.join(':');
  return env;
}

function folderKey(folder) {
  if (!folder) return '';
  return `${folder.dir}\0${folder.relativePath || ''}`;
}

function ensureConfigExtras() {
  if (!Array.isArray(config.bookmarks)) config.bookmarks = [];
  if (!Array.isArray(config.recents)) config.recents = [];
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

function pruneStaleConfig() {
  ensureConfigExtras();
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
  if (changed) {
    saveConfig();
    if (mainWindow && !mainWindow.isDestroyed()) {
      notifyConfigPruned(removed);
    } else {
      pendingPruneNotify = removed;
    }
  }
  return { changed, removed };
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8');
      config = JSON.parse(data);
      if (!Array.isArray(config.directories) || config.directories.length === 0) {
        config.directories = DEFAULT_DIRS;
      }
      ensureConfigExtras();
    }
  } catch {
    config = { directories: DEFAULT_DIRS, bookmarks: [], recents: [] };
  }
  pruneStaleConfig();
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function notifyConfigPruned(removed) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('config-pruned', removed);
  }
}

function notifyPhpServerError(detail) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('php-server-error', { port: PHP_PORT, detail });
  }
}

function checkPhpServerAlive() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PHP_PORT}/`, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

async function startPhpServer(rootDir) {
  await killPhpServer();
  const root = rootDir || config.directories[0];
  if (!root || !fs.existsSync(root)) {
    const msg = !root
      ? 'Добавьте директорию с лендингами'
      : 'Директория не найдена';
    notifyPhpServerError(msg);
    return { ok: false, error: msg };
  }

  const phpBin = await resolveBinary('php');
  if (!phpBin) {
    const msg = 'PHP не найден. Установите: brew install php';
    notifyPhpServerError(msg);
    return { ok: false, error: msg };
  }

  const routerPath = getPhpRouterPath();
  if (!fs.existsSync(routerPath)) {
    const msg = `router.php не найден: ${routerPath}`;
    notifyPhpServerError(msg);
    return { ok: false, error: msg };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = async (ok, error) => {
      if (settled) return;
      settled = true;
      if (!ok) {
        if (phpProcess) {
          try { phpProcess.kill(); } catch { /* ignore */ }
          phpProcess = null;
        }
        notifyPhpServerError(error || 'Не удалось запустить PHP');
      }
      resolve({ ok, error });
    };

    const args = ['-S', `127.0.0.1:${PHP_PORT}`, '-t', root, routerPath];
    phpProcess = spawn(phpBin, args, { stdio: 'ignore' });
    phpProcess.on('error', (err) => finish(false, err.message));
    phpProcess.on('exit', (code) => {
      if (!settled && code !== null && code !== 0) {
        finish(false, `PHP завершился с кодом ${code} (порт ${PHP_PORT} занят?)`);
      }
      phpProcess = null;
    });

    setTimeout(async () => {
      if (!phpProcess) { finish(false, 'PHP не запустился'); return; }
      const alive = await checkPhpServerAlive();
      finish(alive, alive ? undefined : `Порт ${PHP_PORT} недоступен`);
    }, 600);
  });
}

function killPhpServer() {
  return new Promise((resolve) => {
    if (!phpProcess) { resolve(); return; }
    const proc = phpProcess;
    phpProcess = null;
    proc.on('exit', () => resolve());
    proc.on('error', () => resolve());
    proc.kill();
    setTimeout(resolve, 500);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'PHP Browser',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.DS_Store', '.svn', '.hg']);

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
        const relativePath = path.relative(rootPath, fullPath);
        folders.push({
          name: entry.name,
          dir: rootPath,
          relativePath,
        });
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
      folders.push({
        name: path.basename(rootPath),
        dir: rootPath,
        relativePath: '',
      });
    }
  } catch { /* ignore */ }
  await scanDirRecursive(rootPath, rootPath, folders);
  return folders;
}

ipcMain.handle('get-directories', () => {
  pruneStaleConfig();
  return config.directories;
});

ipcMain.handle('add-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Выберите директорию',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false };
  const dir = result.filePaths[0];
  if (config.directories.includes(dir)) return { ok: false, error: 'Уже добавлена' };
  config.directories.push(dir);
  saveConfig();
  await startPhpServer();
  return { ok: true, directories: config.directories };
});

ipcMain.handle('remove-directory', async (_event, dir) => {
  config.directories = config.directories.filter(d => d !== dir);
  saveConfig();
  if (config.directories.length > 0) {
    await startPhpServer();
  }
  return config.directories;
});

ipcMain.handle('scan-folders', async () => {
  pruneStaleConfig();
  let all = [];
  for (const dir of config.directories) {
    const folders = await scanDir(dir);
    all = all.concat(folders);
  }
  all.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return all;
});

ipcMain.handle('set-php-root', async (_event, dir) => startPhpServer(dir));

async function copyDirRecursive(src, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true, encoding: 'utf8' });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDirRecursive(srcPath, destPath);
    else await fs.promises.copyFile(srcPath, destPath);
  }
}

function escapeAppleScriptPath(filePath) {
  return filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function appleScriptCopy(filePath) {
  const safePath = escapeAppleScriptPath(filePath);
  const script = `
use framework "Foundation"
use framework "AppKit"
set pb to current application's NSPasteboard's generalPasteboard()
set url to current application's NSURL's fileURLWithPath:"${safePath}"
pb's clearContents()
pb's writeObjects:{url}
`;
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'AppleScript', '-e', script], (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

ipcMain.handle('copy-folder', async (_event, folder) => {
  try {
    const fullPath = path.join(folder.dir, folder.relativePath || '');
    await appleScriptCopy(fullPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('reveal-in-finder', async (_event, folder) => {
  const fullPath = path.join(folder.dir, folder.relativePath || '');
  shell.showItemInFolder(fullPath);
});

function landingPath(folder) {
  return path.join(folder.dir, folder.relativePath || '');
}

function normalizeLandingRelFile(relativeFile) {
  const rel = (relativeFile || 'index.php').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.includes('..')) throw new Error('Недопустимый путь к файлу');
  return rel;
}

function landingPhpPath(folder, relativeFile = 'index.php') {
  const rel = normalizeLandingRelFile(relativeFile);
  const landing = path.resolve(landingPath(folder));
  const full = path.resolve(path.join(landing, rel));
  if (full !== landing && !full.startsWith(landing + path.sep)) {
    throw new Error('Недопустимый путь к файлу');
  }
  return full;
}

function indexPhpPath(folder) {
  return landingPhpPath(folder, 'index.php');
}

function editorHistoryKey(folder, relativeFile = 'index.php') {
  return `${folderKey(folder)}\0${normalizeLandingRelFile(relativeFile)}`;
}

function editorHistoryDir(folder, relativeFile = 'index.php') {
  const hash = crypto.createHash('sha256').update(editorHistoryKey(folder, relativeFile)).digest('hex').slice(0, 16);
  return path.join(EDITOR_HISTORY_DIR, hash);
}

async function listLandingPhpFilesRecursive(dir, root, results) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'vendor', 'video'].includes(entry.name)) continue;
      await listLandingPhpFilesRecursive(full, root, results);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.php')) {
      results.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
}

async function readEditorMeta(dir) {
  try {
    const raw = await fs.promises.readFile(path.join(dir, 'meta.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeEditorMeta(dir, meta) {
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

async function pruneEditorHistoryFiles(dir, meta) {
  const keep = new Set(meta.map((e) => e.file));
  try {
    const files = await fs.promises.readdir(dir);
    await Promise.all(files.filter((f) => f.endsWith('.php') && !keep.has(f)).map((f) =>
      fs.promises.unlink(path.join(dir, f)).catch(() => {})
    ));
  } catch { /* ignore */ }
}

async function pushEditorHistory(folder, content, relativeFile = 'index.php') {
  const dir = editorHistoryDir(folder, relativeFile);
  const meta = await readEditorMeta(dir);
  if (meta[0]) {
    try {
      const latest = await fs.promises.readFile(path.join(dir, meta[0].file), 'utf8');
      if (latest === content) return;
    } catch { /* continue */ }
  }
  const file = `${Date.now()}.php`;
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, file), content, 'utf8');
  meta.unshift({
    savedAt: Date.now(),
    file,
    preview: content.slice(0, 80).replace(/\s+/g, ' '),
  });
  const trimmed = meta.slice(0, 20);
  await writeEditorMeta(dir, trimmed);
  await pruneEditorHistoryFiles(dir, trimmed);
}

async function migrateEditorHistoryFromConfig() {
  if (!config.editorHistory || typeof config.editorHistory !== 'object') return;
  const entries = Object.entries(config.editorHistory);
  if (entries.length === 0) return;
  for (const [key, hist] of entries) {
    const sep = key.indexOf('\0');
    const folder = {
      dir: sep >= 0 ? key.slice(0, sep) : key,
      relativePath: sep >= 0 ? key.slice(sep + 1) : '',
    };
    for (let i = hist.length - 1; i >= 0; i--) {
      const item = hist[i];
      if (!item?.content) continue;
      const dir = editorHistoryDir(folder);
      const meta = await readEditorMeta(dir);
      const file = `${item.savedAt || Date.now()}-mig.php`;
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, file), item.content, 'utf8');
      meta.push({
        savedAt: item.savedAt || Date.now(),
        file,
        preview: item.content.slice(0, 80).replace(/\s+/g, ' '),
      });
      meta.sort((a, b) => b.savedAt - a.savedAt);
      await writeEditorMeta(dir, meta.slice(0, 20));
    }
  }
  delete config.editorHistory;
  saveConfig();
}

function invalidateIndexCache(filePath) {
  indexContentCache.delete(filePath);
  contentSearchCache = { query: '', results: [], at: 0 };
}

async function readIndexCached(folder) {
  const filePath = indexPhpPath(folder);
  const stat = await fs.promises.stat(filePath);
  const cached = indexContentCache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs) return cached.content;
  const content = await fs.promises.readFile(filePath, 'utf8');
  indexContentCache.set(filePath, { mtime: stat.mtimeMs, content });
  return content;
}

ipcMain.handle('list-landing-php-files', async (_event, folder) => {
  try {
    const root = landingPath(folder);
    if (!fs.existsSync(root)) return [];
    const files = [];
    await listLandingPhpFilesRecursive(root, root, files);
    files.sort((a, b) => {
      if (a === 'index.php') return -1;
      if (b === 'index.php') return 1;
      return a.localeCompare(b, 'ru');
    });
    return files;
  } catch {
    return [];
  }
});

ipcMain.handle('get-landing-source', async (_event, folder, relativeFile) => {
  try {
    const filePath = landingPhpPath(folder, relativeFile);
    if (!fs.existsSync(filePath)) return { ok: false, error: 'Файл не найден' };
    const content = await fs.promises.readFile(filePath, 'utf8');
    return { ok: true, content, file: normalizeLandingRelFile(relativeFile) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('save-landing-source', async (_event, folder, content, relativeFile) => {
  try {
    const filePath = landingPhpPath(folder, relativeFile);
    let previous = '';
    try {
      previous = await fs.promises.readFile(filePath, 'utf8');
    } catch { /* new file */ }
    if (previous && previous !== content) {
      await pushEditorHistory(folder, previous, relativeFile);
    }
    await fs.promises.writeFile(filePath, content, 'utf8');
    if (normalizeLandingRelFile(relativeFile) === 'index.php') {
      invalidateIndexCache(filePath);
    }
    return { ok: true, file: normalizeLandingRelFile(relativeFile) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-editor-history', async (_event, folder, relativeFile) => {
  const meta = await readEditorMeta(editorHistoryDir(folder, relativeFile));
  return meta.map((h, i) => ({
    index: i,
    savedAt: h.savedAt,
    preview: h.preview || '',
  }));
});

ipcMain.handle('get-editor-history-content', async (_event, folder, index, relativeFile) => {
  const dir = editorHistoryDir(folder, relativeFile);
  const meta = await readEditorMeta(dir);
  const entry = meta[index];
  if (!entry) return { ok: false, error: 'Версия не найдена' };
  try {
    const content = await fs.promises.readFile(path.join(dir, entry.file), 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('add-recent', (_event, folder) => {
  ensureConfigExtras();
  const key = folderKey(folder);
  config.recents = config.recents.filter((r) => folderKey(r) !== key);
  config.recents.unshift({ dir: folder.dir, relativePath: folder.relativePath || '', name: folder.name, openedAt: Date.now() });
  config.recents = config.recents.slice(0, 15);
  saveConfig();
  return config.recents;
});

ipcMain.handle('get-recents', () => {
  ensureConfigExtras();
  pruneStaleConfig();
  return config.recents;
});

ipcMain.handle('get-bookmarks', () => {
  ensureConfigExtras();
  pruneStaleConfig();
  return config.bookmarks;
});

ipcMain.handle('toggle-bookmark', (_event, folder) => {
  ensureConfigExtras();
  const key = folderKey(folder);
  const idx = config.bookmarks.findIndex((b) => folderKey(b) === key);
  if (idx >= 0) {
    config.bookmarks.splice(idx, 1);
    saveConfig();
    return { bookmarked: false, bookmarks: config.bookmarks };
  }
  config.bookmarks.push({ dir: folder.dir, relativePath: folder.relativePath || '', name: folder.name });
  saveConfig();
  return { bookmarked: true, bookmarks: config.bookmarks };
});

ipcMain.handle('is-bookmarked', (_event, folder) => {
  ensureConfigExtras();
  const key = folderKey(folder);
  return config.bookmarks.some((b) => folderKey(b) === key);
});

ipcMain.handle('duplicate-landing', async (_event, folder) => {
  try {
    const src = landingPath(folder);
    if (!fs.existsSync(src)) return { ok: false, error: 'Папка не найдена' };
    const parent = path.dirname(src);
    const baseName = path.basename(src);
    let destName = `${baseName}-copy`;
    let dest = path.join(parent, destName);
    let n = 1;
    while (fs.existsSync(dest)) {
      destName = `${baseName}-copy-${n++}`;
      dest = path.join(parent, destName);
    }
    await copyDirRecursive(src, dest);

    const isRootLanding = !folder.relativePath && folder.dir === src;
    let newFolder;
    if (isRootLanding) {
      if (!config.directories.includes(dest)) {
        config.directories.push(dest);
        saveConfig();
      }
      newFolder = { name: destName, dir: dest, relativePath: '' };
    } else {
      newFolder = {
        name: destName,
        dir: folder.dir,
        relativePath: folder.relativePath
          ? path.join(path.dirname(folder.relativePath), destName)
          : destName,
      };
    }
    return { ok: true, folder: newFolder };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('search-content', async (_event, query) => {
  const q = (query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  if (contentSearchCache.query === q && Date.now() - contentSearchCache.at < SEARCH_CACHE_TTL_MS) {
    return contentSearchCache.results;
  }
  const results = [];
  const max = 80;
  for (const dir of config.directories) {
    const folders = await scanDir(dir);
    for (const f of folders) {
      if (results.length >= max) break;
      try {
        const content = await readIndexCached(f);
        if (content.toLowerCase().includes(q)) results.push(f);
      } catch { /* skip */ }
    }
    if (results.length >= max) break;
  }
  contentSearchCache = { query: q, results, at: Date.now() };
  return results;
});

async function runFfmpegWithProgress(args, options, durationSec) {
  const ffmpegBin = await resolveBinary('ffmpeg');
  if (!ffmpegBin) throw new Error('ffmpeg не найден. Установите: brew install ffmpeg');

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (!durationSec || !mainWindow || mainWindow.isDestroyed()) return;
      const matches = stderr.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/g);
      if (!matches) return;
      const last = matches[matches.length - 1];
      const parts = last.replace('time=', '').split(':');
      const secs = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
      const pct = Math.min(99, Math.round((secs / durationSec) * 100));
      mainWindow.webContents.send('video-encode-progress', { pct, secs: Math.round(secs) });
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('video-encode-progress', { pct: 100 });
        }
        resolve();
      } else {
        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      }
    });
  });
}

function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
    });
  });
}

function getVideoDuration(filePath) {
  const probe = (bin, args) => new Promise((resolve, reject) => {
    execFile(bin, args, (err, stdout) => {
      if (err) reject(err);
      else resolve(parseFloat(stdout.trim()) || 0);
    });
  });

  return resolveBinary('ffprobe').then(async (ffprobeBin) => {
    if (!ffprobeBin) throw new Error('ffprobe не найден. Установите: brew install ffmpeg');

    const duration = await probe(ffprobeBin, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    if (duration > 0) return duration;

    const streamDuration = await probe(ffprobeBin, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    if (streamDuration > 0) return streamDuration;
    throw new Error('Не удалось определить длительность видео');
  });
}

function formatDuration(sec) {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function calcVideoEncodeParams(durationSec) {
  const audioKbps = VIDEO_AUDIO_KBPS;
  const minutes = durationSec / 60;

  let videoKbps = 900;
  if (durationSec > 0) {
    const maxTotalKbps = (VIDEO_TARGET_MB * 1024 * 1024 * 8) / durationSec / 1000;
    // Запас ~5.6% — подогнано под таблицу в НАСТРОЙКА.php (12 мин → 900k, 20 мин → 500k)
    videoKbps = Math.floor((maxTotalKbps - audioKbps) * 0.944);
  }

  const minKbps = 250;
  const maxKbps = 5000;
  videoKbps = Math.min(maxKbps, Math.max(minKbps, videoKbps));

  const maxrateKbps = Math.round(videoKbps * 1.22);
  const bufsizeKbps = Math.round(videoKbps * 2.44);
  const preset = minutes >= 13 && minutes < 15 ? 'medium' : 'slow';
  const estMb = Math.round(((videoKbps + audioKbps) * durationSec / 8 / 1024) * 10) / 10;

  return { videoKbps, maxrateKbps, bufsizeKbps, audioKbps, preset, estMb };
}

function buildFfmpegHlsArgs(params, inputPath) {
  return [
    '-y', '-i', inputPath,
    '-hls_time', '4',
    '-hls_list_size', '0',
    '-hls_segment_filename', 'segments/segment%d.ts',
    '-hls_playlist_type', 'vod',
    '-c:v', 'libx264', '-preset', params.preset,
    '-b:v', `${params.videoKbps}k`,
    '-maxrate', `${params.maxrateKbps}k`,
    '-bufsize', `${params.bufsizeKbps}k`,
    '-c:a', 'aac', '-b:a', `${params.audioKbps}k`,
    'segments/playlist.m3u8',
  ];
}

async function cleanupVideoDirSources(videoDir) {
  const videoExt = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v']);
  try {
    const entries = await fs.promises.readdir(videoDir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) return;
      if (!videoExt.has(path.extname(entry.name).toLowerCase())) return;
      await fs.promises.unlink(path.join(videoDir, entry.name));
    }));
  } catch { /* ignore */ }
}

async function clearDir(dirPath) {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    await Promise.all(entries.map((entry) => {
      const full = path.join(dirPath, entry.name);
      return entry.isDirectory()
        ? fs.promises.rm(full, { recursive: true, force: true })
        : fs.promises.unlink(full);
    }));
  } catch {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }
}

function folderLabel(folder) {
  if (!folder) return '';
  return folder.relativePath || folder.name || path.basename(folder.dir);
}

ipcMain.handle('get-video-encode-status', () => {
  if (!videoEncodeJob) return { active: false };
  return { active: true, folder: videoEncodeJob.folder };
});

ipcMain.handle('confirm-switch-during-encode', async (_event, label) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Переключить', 'Остаться'],
    defaultId: 1,
    cancelId: 1,
    title: 'Идёт кодирование видео',
    message: `Видео ещё кодируется: ${label}`,
    detail: 'Кодирование продолжится в фоне для этого лендинга. Переключиться на другой?',
  });
  return { ok: response === 0 };
});

function inspectVideoSetup(folder) {
  const landing = landingPath(folder);
  const indexPath = indexPhpPath(folder);

  let content = '';
  try {
    content = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return {
      ok: false,
      message: 'index.php не найден',
      detail: 'Невозможно проверить, использует ли лендинг видео.',
    };
  }

  const hasPlaylist = fs.existsSync(path.join(landing, 'video', 'segments', 'playlist.m3u8'));
  const hasVideoDir = fs.existsSync(path.join(landing, 'video'));
  const codeRefs = /video\/segments|playlist\.m3u8|video\.js|hls\.js|application\/x-mpegURL|video\/video\.mp4/i.test(content);

  if (codeRefs || hasPlaylist) return { ok: true };

  const detail = [
    !hasVideoDir ? 'Папки video/ нет — будет создана.' : 'Папка video/ есть, но плейлист не найден.',
    'В index.php нет ссылок на HLS (playlist.m3u8 / video.js).',
    'HLS всё равно создастся в video/segments/, но на странице видео может не появиться.',
  ].join('\n');

  return {
    ok: false,
    message: 'На лендинге не настроено видео',
    detail,
  };
}

ipcMain.handle('replace-video', async (_event, folder) => {
  if (videoEncodeJob) {
    return { ok: false, error: 'Уже идёт кодирование другого видео' };
  }
  try {
    const setup = inspectVideoSetup(folder);
    if (!setup.ok) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Продолжить', 'Отмена'],
        defaultId: 1,
        cancelId: 1,
        title: 'Видео на лендинге',
        message: setup.message,
        detail: setup.detail,
      });
      if (response !== 0) return { ok: false, canceled: true };
    }

    const pickResult = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите видео',
      properties: ['openFile'],
      filters: [
        { name: 'Видео', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] },
      ],
    });
    if (pickResult.canceled || pickResult.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }

    const sourceVideo = pickResult.filePaths[0];
    const duration = await getVideoDuration(sourceVideo);
    const encodeParams = calcVideoEncodeParams(duration);
    const maxSeconds = VIDEO_MAX_MINUTES * 60;

    if (duration > maxSeconds) {
      const minutes = Math.ceil(duration / 60);
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Продолжить', 'Отмена'],
        defaultId: 1,
        cancelId: 1,
        title: 'Длинное видео',
        message: `Видео длится ~${minutes} мин (больше ${VIDEO_MAX_MINUTES} мин)`,
        detail: `Целевой размер — ~${VIDEO_TARGET_MB} МБ. Битрейт будет низким (${encodeParams.videoKbps}k). Продолжить?`,
      });
      if (response !== 0) return { ok: false, canceled: true };
    }

    const { response: confirmEncode } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Кодировать', 'Отмена'],
      defaultId: 0,
      cancelId: 1,
      title: 'Замена видео',
      message: `Длительность: ${formatDuration(duration)}`,
      detail: [
        `Цель: ~${VIDEO_TARGET_MB} МБ · оценка: ~${encodeParams.estMb} МБ`,
        `preset ${encodeParams.preset} · libx264`,
        `-b:v ${encodeParams.videoKbps}k · -maxrate ${encodeParams.maxrateKbps}k · -bufsize ${encodeParams.bufsizeKbps}k`,
        `-c:a aac · -b:a ${encodeParams.audioKbps}k`,
        'HLS → video/segments/playlist.m3u8',
      ].join('\n'),
    });
    if (confirmEncode !== 0) return { ok: false, canceled: true };

    const landing = landingPath(folder);
    videoEncodeJob = { folder: { ...folder }, landing };

    const videoDir = path.join(landing, 'video');
    const segmentsDir = path.join(videoDir, 'segments');

    await fs.promises.mkdir(segmentsDir, { recursive: true });
    await clearDir(segmentsDir);

    await runFfmpegWithProgress(
      buildFfmpegHlsArgs(encodeParams, sourceVideo),
      { cwd: videoDir },
      duration,
    );

    try {
      await cleanupVideoDirSources(videoDir);
    } catch { /* ignore */ }

    const encodeResult = {
      ok: true,
      duration,
      ...encodeParams,
      targetMb: VIDEO_TARGET_MB,
      folder: videoEncodeJob.folder,
      label: folderLabel(folder),
    };
    videoEncodeJob = null;
    return encodeResult;
  } catch (err) {
    videoEncodeJob = null;
    return { ok: false, error: err.message };
  }
});

function execText(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function checkMimo() {
  const candidates = [
    path.join(os.homedir(), '.mimocode/bin/mimo'),
    '/opt/homebrew/bin/mimo',
    '/usr/local/bin/mimo',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const version = await execText(p, ['--version']);
        return { installed: true, path: p, version };
      } catch {
        return { installed: true, path: p, version: null };
      }
    }
  }
  try {
    const p = await execText('which', ['mimo']);
    const version = await execText(p, ['--version']);
    return { installed: true, path: p, version };
  } catch {
    return { installed: false };
  }
}

function getLandingCwd(folder) {
  if (!folder) return os.homedir();
  return path.join(folder.dir, folder.relativePath || '');
}

function shellEnv() {
  const env = enrichPath({ ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  return env;
}

function killPty() {
  if (!ptyProcess) return;
  try { ptyProcess.kill(); } catch { /* ignore */ }
  ptyProcess = null;
}

function startPty(cwd) {
  killPty();
  const shell = process.env.SHELL || '/bin/zsh';
  ptyProcess = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd || os.homedir(),
    env: shellEnv(),
  });
  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', data);
    }
  });
  ptyProcess.onExit(() => {
    ptyProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-exit');
    }
  });
}

ipcMain.handle('check-mimo', () => checkMimo());

ipcMain.handle('prompt-install-mimo', async () => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Установить в терминале', 'Отмена'],
    defaultId: 0,
    cancelId: 1,
    title: 'MiMo не установлен',
    message: 'MiMo Code (Xiaomi) не найден в системе',
    detail: 'Запустить официальный скрипт установки в терминале?\ncurl -fsSL https://mimo.xiaomi.com/install | bash',
  });
  return { ok: response === 0 };
});

ipcMain.handle('get-mimo-install-command', () => ({
  command: 'curl -fsSL https://mimo.xiaomi.com/install | bash',
}));

ipcMain.handle('get-terminal-cwd', (_event, folder) => getLandingCwd(folder));

ipcMain.handle('terminal-start', (_event, cwd) => {
  startPty(cwd);
  return { ok: true };
});

ipcMain.handle('terminal-write', (_event, data) => {
  if (ptyProcess) ptyProcess.write(data);
  return { ok: true };
});

ipcMain.handle('terminal-resize', (_event, cols, rows) => {
  if (ptyProcess && cols > 0 && rows > 0) ptyProcess.resize(cols, rows);
  return { ok: true };
});

ipcMain.handle('terminal-kill', () => {
  killPty();
  return { ok: true };
});

app.whenReady().then(async () => {
  loadConfig();
  await migrateEditorHistoryFromConfig();
  await resolveBinary('php');
  await resolveBinary('ffmpeg');
  await resolveBinary('ffprobe');
  const phpResult = await startPhpServer();
  createWindow();
  if (pendingPruneNotify) {
    setTimeout(() => notifyConfigPruned(pendingPruneNotify), 500);
    pendingPruneNotify = null;
  }
  if (!phpResult.ok && config.directories.length > 0) {
    setTimeout(() => notifyPhpServerError(phpResult.error), 500);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (phpProcess) phpProcess.kill();
  killPty();
});
app.on('window-all-closed', () => {
  killPhpServer();
  if (process.platform !== 'darwin') app.quit();
});
