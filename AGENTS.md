# PHP Browser — Architecture & Feature Reference

## Project Overview
Electron desktop app for browsing and editing local PHP affiliate landing pages. Scans multiple directories recursively, serves them via built-in PHP server with router, displays in webview with grouped sidebar navigation, CodeMirror editor, terminal, and video replacement (ffmpeg HLS).

## File Structure
```
/Users/vladimir_nortsev/Desktop/PHPBrauzer/
├── package.json          # deps: electron, electron-builder, codemirror, xterm, node-pty
├── main.js               # Main process: PHP server, IPC, ffmpeg, pty, scanning, editor history
├── preload.js            # Context bridge: exposes api.* to renderer
├── index.html            # Renderer: full UI (HTML + CSS + JS)
├── features.js           # Tabs, bookmarks, recents, encode progress, content search UI
├── editor.js             # CodeMirror wrapper (SourceEditor)
├── terminal-panel.js     # xterm.js + node-pty bridge
├── editor-theme.css      # CodeMirror dark theme
├── router.php            # PHP built-in server router ($rawClick / $click)
├── dist/                 # Built output (mac-arm64/PHP Browser.app)
```

## Config
- **Path**: `~/.local/share/php-brauzer/config.json` (electron userData)
- **Format**: `{ "directories": [...], "bookmarks": [...], "recents": [...] }`
- **Editor history**: `~/.local/share/php-brauzer/editor-history/<hash>/` — meta.json + `.php` files (max 20 per landing)
- **Default directories**: `[]` (user adds via «+ Добавить директорию» on first launch)

## main.js — Key Functions

### PHP Server
- `startPhpServer(rootDir)` — kills old process, spawns `php -S 127.0.0.1:8080 -t <root> router.php`, health-checks port, returns `{ ok, error? }`
- `killPhpServer()` — async, waits for exit (500ms timeout)
- Server restarts when user switches to a folder from a different root directory (or tab switch)
- On failure: sends `php-server-error` IPC → toast in renderer

### router.php
Sets `$rawClick = true` and `$click = true` before requiring index.php — landings with `die()` on missing tracker params work in preview.

### Recursive Scanning
- `scanDir(rootPath)` — if `index.php` in root → `{ relativePath: '' }`; then `scanDirRecursive`
- `scanDirRecursive` — deep traversal, stops at folders containing `index.php`
- Skips: `node_modules`, `.git`, `.svn`, `.hg`, all dotfiles/dotdirs

### Video (ffmpeg)
- `replace-video` — pick file (любое имя) → HLS в `video/segments/playlist.m3u8`, битрейт от длительности (~90 МБ); после успеха удаляются исходные `.mp4/.mov/...` в `video/`
- Target ~90 MB (`VIDEO_TARGET_MB`), bitrate from duration; warn if >33 min
- Progress via `video-encode-progress` IPC; one encode at a time
- `confirm-switch-during-encode` — dialog if user switches folder during encode

### Terminal / MiMo
- `terminal-start/write/resize/kill` — node-pty shell in landing cwd
- `check-mimo` — looks in `~/.mimocode/bin/mimo`, Homebrew paths
- `prompt-install-mimo` — offers `curl -fsSL https://mimo.xiaomi.com/install | bash`

### IPC Handlers (main → renderer via preload `window.api.*`)
| Handler | Notes |
|---------|-------|
| `get-directories`, `add-directory`, `remove-directory` | Config directories |
| `scan-folders` | Recursive scan all directories |
| `set-php-root` | Restart PHP server → `{ ok, error? }` |
| `copy-folder`, `reveal-in-finder`, `duplicate-landing` | Folder ops |
| `get-landing-source`, `save-landing-source` | CodeMirror editor; autosave pushes file-based history |
| `get-editor-history`, `get-editor-history-content` | Version history (files, not config) |
| `replace-video`, `get-video-encode-status`, `confirm-switch-during-encode` | Video pipeline |
| `search-content` | Search in index.php bodies (cached 5 min + per-file mtime cache) |
| `get-bookmarks`, `toggle-bookmark`, `is-bookmarked`, `get-recents`, `add-recent` | Sidebar state |
| `check-mimo`, `prompt-install-mimo`, `get-mimo-install-command` | MiMo Code |
| `terminal-*`, `get-terminal-cwd` | Embedded terminal |

### Folder Object Shape
```js
{
  name: "Erovitan",
  dir: "/Volumes/Arbitration/lander",
  relativePath: "Архив/Диман/Март/Erovitan"  // "" if index.php in root of dir
}
```

## preload.js
Exposes `window.api.*` — all IPC invoke helpers + `onTerminalData`, `onTerminalExit`, `onVideoEncodeProgress`, `onPhpServerError`.

## index.html — UI

### Layout
- **Sidebar** (320px): recents, bookmarks, directories, grouped folder list, search (+ «в коде index.php»)
- **Content**: tab bar, address bar, webview stack, optional CodeMirror panel, optional terminal panel

### Key Buttons
Редактировать (index.php), Заменить видео, ↻, Finder, Дубль, ☆, Терминал, MiMo Code

### Tabs
- `features.js` TabManager — multiple webviews; switching tab calls `__switchToFolder` → `setPhpRoot` if root dir changed

### URL Construction
```js
const segments = folder.relativePath.split(/[/\\]/).filter(s => s && s !== '.');
const url = segments.length === 0
  ? 'http://localhost:8080/index.php'
  : `http://localhost:8080/${segments.map(encodeURIComponent).join('/')}/index.php`;
```

### Editor
- CodeMirror 5, mode `application/x-httpd-php`, autosave ~1.2s (`SOURCE_SAVE_DELAY_MS`)
- History dropdown restores prior versions from `editor-history/`

## Build & Run
- `npm start` — **must** use `env -u ELECTRON_RUN_AS_NODE electron .` (in package.json script)
- `npm run build:dir` — unpacked .app in dist/mac-arm64/
- `npm run build` — .dmg installer
- `postinstall`: electron-rebuild for node-pty

## Known Behaviors
- PHP server serves ONE directory at a time (document root)
- Switching folders/tabs from different dirs triggers server restart
- webview CSP: `frame-src http://localhost:8080`
- Cyrillic paths: encodeURIComponent per segment
- NSPasteboard copy via AppleScript (paths escaped for quotes/backslashes)
- Legacy `editorHistory` in config.json auto-migrates to files on startup
