/* global Terminal, FitAddon, SourceEditor, TerminalPanel */
window.AppFeatures = (function () {
  let bookmarks = [];
  let recents = [];
  let contentSearchTimer = null;
  let contentSearchIds = null;
  let onEncodeProgress = null;

  const TabManager = (function () {
    let tabs = [];
    let activeId = null;
    let nextId = 1;
    let container = null;
    let tabsList = null;

    function renderTabs() {
      if (!tabsList) return;
      tabsList.innerHTML = '';
      for (const tab of tabs) {
        const el = document.createElement('div');
        el.className = 'preview-tab' + (tab.id === activeId ? ' active' : '');
        el.title = tab.title;
        el.innerHTML = `<span class="tab-title">${escapeHtml(tab.title)}</span>${tabs.length > 1 ? '<button class="tab-close">×</button>' : ''}`;
        el.addEventListener('click', (e) => {
          if (e.target.classList.contains('tab-close')) {
            e.stopPropagation();
            closeTab(tab.id);
          } else {
            switchTab(tab.id);
          }
        });
        tabsList.appendChild(el);
      }
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    }

    function createTab(folder = null, url = 'about:blank') {
      const id = nextId++;
      const wv = document.createElement('webview');
      wv.setAttribute('partition', 'persist:phpbrowser');
      wv.src = url;
      wv.className = 'preview-webview';
      wv.style.display = 'none';
      container.appendChild(wv);
      const title = folder ? (folder.relativePath || folder.name) : 'Новая вкладка';
      const tab = { id, folder: folder ? { ...folder } : null, webview: wv, title };
      tabs.push(tab);
      if (url !== 'about:blank') wv.loadURL(url);
      switchTab(id);
      renderTabs();
      return tab;
    }

    function switchTab(id) {
      activeId = id;
      tabs.forEach((t) => {
        t.webview.style.display = t.id === id ? 'flex' : 'none';
      });
      renderTabs();
      const tab = tabs.find((t) => t.id === id);
      if (tab?.folder && window.__switchToFolder) {
        window.__switchToFolder(tab.folder);
      }
      return tab;
    }

    function getActive() {
      return tabs.find((t) => t.id === activeId);
    }

    function getActiveWebview() {
      return getActive()?.webview || null;
    }

    function closeTab(id) {
      if (tabs.length <= 1) return;
      const idx = tabs.findIndex((t) => t.id === id);
      const tab = tabs[idx];
      tab.webview.remove();
      tabs.splice(idx, 1);
      if (activeId === id) switchTab(tabs[Math.max(0, idx - 1)].id);
      renderTabs();
    }

    function updateActive(folder, url) {
      const tab = getActive();
      if (!tab) return;
      tab.folder = folder ? { ...folder } : null;
      tab.title = folder ? (folder.relativePath || folder.name) : tab.title;
      tab.webview.loadURL(url);
      renderTabs();
    }

    function reloadActive() {
      getActiveWebview()?.reload();
    }

    function init(stackEl, listEl) {
      container = stackEl;
      tabsList = listEl;
      createTab();
    }

    return { init, createTab, switchTab, getActive, getActiveWebview, closeTab, updateActive, reloadActive };
  })();

  function isBookmarked(folder) {
    return bookmarks.some((b) => folderKey(b) === folderKey(folder));
  }

  function folderKey(f) {
    return f ? `${f.dir}\0${f.relativePath || ''}` : '';
  }

  async function loadBookmarksRecents() {
    bookmarks = await window.api.getBookmarks();
    recents = await window.api.getRecents();
    renderRecents();
    renderBookmarks();
  }

  function renderRecents() {
    const el = document.getElementById('recents-list');
    if (!el) return;
    el.innerHTML = '';
    if (recents.length === 0) {
      el.innerHTML = '<div class="side-empty">Пусто</div>';
      return;
    }
    for (const f of recents) {
      const item = document.createElement('div');
      item.className = 'side-item';
      item.textContent = f.relativePath || f.name;
      item.title = f.dir;
      item.addEventListener('click', () => window.__selectFolder({ dir: f.dir, relativePath: f.relativePath || '', name: f.name }));
      el.appendChild(item);
    }
  }

  function renderBookmarks() {
    const el = document.getElementById('bookmarks-list');
    if (!el) return;
    el.innerHTML = '';
    if (bookmarks.length === 0) {
      el.innerHTML = '<div class="side-empty">Нет закладок</div>';
      return;
    }
    for (const f of bookmarks) {
      const item = document.createElement('div');
      item.className = 'side-item';
      item.innerHTML = `<span>★</span> ${f.relativePath || f.name}`;
      item.title = f.dir;
      item.addEventListener('click', () => window.__selectFolder({ dir: f.dir, relativePath: f.relativePath || '', name: f.name }));
      el.appendChild(item);
    }
  }

  async function toggleBookmark(folder) {
    const res = await window.api.toggleBookmark(folder);
    bookmarks = res.bookmarks;
    renderBookmarks();
    window.__renderFolders?.();
    return res.bookmarked;
  }

  async function refreshEditorHistory(folder, relativeFile) {
    const sel = document.getElementById('editor-history');
    if (!sel || !folder) return;
    const file = relativeFile || window.__getActiveEditorFile?.() || 'index.php';
    const items = await window.api.getEditorHistory(folder, file);
    sel.innerHTML = '<option value="">История</option>';
    for (const h of items) {
      const d = new Date(h.savedAt);
      const label = `${d.toLocaleString('ru')} — ${h.preview}…`;
      const opt = document.createElement('option');
      opt.value = String(h.index);
      opt.textContent = label;
      sel.appendChild(opt);
    }
  }

  function appendBname(url) {
    return url;
  }

  function setEncodeProgress(pct) {
    const bar = document.getElementById('encode-progress');
    const fill = document.getElementById('encode-progress-fill');
    if (!bar || !fill) return;
    if (pct <= 0) {
      bar.style.display = 'none';
      fill.style.width = '0%';
      return;
    }
    bar.style.display = 'block';
    fill.style.width = `${pct}%`;
    if (pct >= 100) setTimeout(() => setEncodeProgress(0), 2000);
  }

  function init(opts) {
    const webviewStack = document.getElementById('webview-stack');
    const tabsList = document.getElementById('tabs-list');
    TabManager.init(webviewStack, tabsList);

    document.getElementById('btn-new-tab')?.addEventListener('click', () => {
      const cur = TabManager.getActive()?.folder;
      if (cur && window.__buildUrl) {
        TabManager.createTab(cur, appendBname(window.__buildUrl(cur)));
      } else {
        TabManager.createTab();
      }
    });

    document.getElementById('btn-finder')?.addEventListener('click', () => {
      const f = window.__getActiveFolder?.();
      if (f) window.api.revealInFinder(f);
      else opts.showToast('Выберите лендинг', true);
    });

    document.getElementById('btn-duplicate')?.addEventListener('click', async () => {
      const f = window.__getActiveFolder?.();
      if (!f) { opts.showToast('Выберите лендинг', true); return; }
      const res = await window.api.duplicateLanding(f);
      if (res.ok) {
        opts.showToast('Копия создана');
        await window.__loadFolders?.();
        window.__selectFolder(res.folder);
      } else {
        opts.showToast(res.error, true);
      }
    });

    document.getElementById('btn-bookmark')?.addEventListener('click', async () => {
      const f = window.__getActiveFolder?.();
      if (!f) { opts.showToast('Выберите лендинг', true); return; }
      const on = await toggleBookmark(f);
      opts.showToast(on ? 'В закладках' : 'Убрано из закладок');
      updateBookmarkBtn(f);
    });

    document.getElementById('search-in-code')?.addEventListener('change', () => {
      window.__renderFolders?.();
    });

    document.getElementById('editor-history')?.addEventListener('change', async (e) => {
      const idx = e.target.value;
      if (idx === '' || !window.__getActiveFolder) return;
      const f = window.__getActiveFolder();
      const res = await window.api.getEditorHistoryContent(f, parseInt(idx, 10), window.__getActiveEditorFile?.() || 'index.php');
      if (res.ok) {
        SourceEditor.setValue(res.content);
        opts.showToast('Версия загружена — сохранится автоматически');
        e.target.value = '';
      }
    });

    window.api.onVideoEncodeProgress((data) => setEncodeProgress(data.pct));

    loadBookmarksRecents();

    recentsPanelToggle();
    bookmarksPanelToggle();
  }

  function recentsPanelToggle() {
    document.getElementById('recents-header')?.addEventListener('click', () => {
      const list = document.getElementById('recents-list');
      const h = document.getElementById('recents-header');
      const open = list.style.display !== 'none';
      list.style.display = open ? 'none' : 'block';
      h.classList.toggle('collapsed', open);
    });
  }

  function bookmarksPanelToggle() {
    document.getElementById('bookmarks-header')?.addEventListener('click', () => {
      const list = document.getElementById('bookmarks-list');
      const h = document.getElementById('bookmarks-header');
      const open = list.style.display !== 'none';
      list.style.display = open ? 'none' : 'block';
      h.classList.toggle('collapsed', open);
    });
  }

  async function updateBookmarkBtn(folder) {
    const btn = document.getElementById('btn-bookmark');
    if (!btn || !folder) return;
    const on = await window.api.isBookmarked(folder);
    btn.textContent = on ? '★' : '☆';
    btn.classList.toggle('active', on);
  }

  async function onFolderOpened(folder) {
    recents = await window.api.addRecent(folder);
    renderRecents();
    updateBookmarkBtn(folder);
    refreshEditorHistory(folder);
  }

  async function filterContentSearch(query, nameFiltered) {
    const inCode = document.getElementById('search-in-code')?.checked;
    if (!inCode || query.length < 2) {
      contentSearchIds = null;
      return nameFiltered;
    }
    return new Promise((resolve) => {
      clearTimeout(contentSearchTimer);
      contentSearchTimer = setTimeout(async () => {
        const found = await window.api.searchContent(query);
        contentSearchIds = new Set(found.map(folderKey));
        resolve(nameFiltered.filter((f) => contentSearchIds.has(folderKey(f))));
      }, 400);
    });
  }

  function decorateFolderItem(el, folder) {
    if (!isBookmarked(folder) || el.querySelector('.folder-star')) return;
    const star = document.createElement('span');
    star.className = 'folder-star';
    star.textContent = '★';
    el.prepend(star);
  }

  return {
    TabManager,
    init,
    appendBname,
    onFolderOpened,
    updateBookmarkBtn,
    toggleBookmark,
    filterContentSearch,
    decorateFolderItem,
    folderKey,
    setEncodeProgress,
    refreshEditorHistory,
    isBookmarked,
    loadBookmarksRecents,
  };
})();
