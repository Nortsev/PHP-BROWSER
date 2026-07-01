(function () {
  let cm = null;
  let changeCallback = null;
  let searchMarks = [];
  const SEARCH_OPTS = { caseFold: true };

  function init(textarea) {
    if (cm) return cm;

    cm = CodeMirror.fromTextArea(textarea, {
      mode: 'application/x-httpd-php',
      theme: 'phpbrowser',
      lineNumbers: true,
      lineWrapping: false,
      matchBrackets: true,
      autoCloseBrackets: true,
      styleActiveLine: true,
      indentUnit: 2,
      tabSize: 2,
      indentWithTabs: false,
      scrollbarStyle: 'native',
      extraKeys: {
        'Cmd-S': () => { if (window._editorSave) window._editorSave(); },
        'Ctrl-S': () => { if (window._editorSave) window._editorSave(); },
        'Cmd-F': () => { window._editorFocusSearch?.(); },
        'Ctrl-F': () => { window._editorFocusSearch?.(); },
        Tab: (editor) => {
          if (editor.somethingSelected()) editor.indentSelection('add');
          else editor.replaceSelection('  ', 'end');
        },
      },
    });

    cm.on('change', () => {
      if (changeCallback) changeCallback();
    });

    return cm;
  }

  function clearSearchMarks() {
    searchMarks.forEach((m) => m.clear());
    searchMarks = [];
  }

  function countMatches(query) {
    if (!cm || !query) return 0;
    let count = 0;
    const cursor = cm.getSearchCursor(query, CodeMirror.Pos(0, 0), SEARCH_OPTS);
    while (cursor.findNext()) count++;
    return count;
  }

  function highlightMatches(query) {
    clearSearchMarks();
    if (!cm || !query) return 0;
    const cursor = cm.getSearchCursor(query, CodeMirror.Pos(0, 0), SEARCH_OPTS);
    while (cursor.findNext()) {
      searchMarks.push(cm.markText(cursor.from(), cursor.to(), { className: 'cm-search-match' }));
    }
    return searchMarks.length;
  }

  function matchIndexAt(query, pos) {
    let idx = 0;
    const cursor = cm.getSearchCursor(query, CodeMirror.Pos(0, 0), SEARCH_OPTS);
    while (cursor.findNext()) {
      idx++;
      if (CodeMirror.cmpPos(cursor.from(), pos) === 0) return idx;
    }
    return 0;
  }

  function findMatch(query, backward) {
    if (!cm || !query.trim()) {
      clearSearchMarks();
      return { found: false, total: 0, index: 0 };
    }

    const total = highlightMatches(query);
    if (total === 0) return { found: false, total: 0, index: 0 };

    const from = cm.getCursor();
    let cursor = cm.getSearchCursor(query, from, SEARCH_OPTS);
    let ok = backward ? cursor.findPrevious() : cursor.findNext();

    if (!ok) {
      cursor = cm.getSearchCursor(
        query,
        backward ? CodeMirror.Pos(cm.lastLine()) : CodeMirror.Pos(0, 0),
        SEARCH_OPTS,
      );
      ok = backward ? cursor.findPrevious() : cursor.findNext();
    }

    if (!ok) return { found: false, total, index: 0 };

    cm.setSelection(cursor.from(), cursor.to());
    cm.scrollIntoView({ from: cursor.from(), to: cursor.to() }, 60);
    return { found: true, total, index: matchIndexAt(query, cursor.from()) };
  }

  window.SourceEditor = {
    init,
    getValue() {
      return cm ? cm.getValue() : '';
    },
    setValue(value) {
      if (cm) cm.setValue(value || '');
      clearSearchMarks();
    },
    focus() {
      if (cm) cm.focus();
    },
    refresh() {
      if (cm) cm.refresh();
    },
    onChange(callback) {
      changeCallback = callback;
    },
    isFocused() {
      return cm ? cm.hasFocus() : false;
    },
    clearSearch() {
      clearSearchMarks();
    },
    search(query, backward = false) {
      return findMatch(query, backward);
    },
    updateSearchHighlight(query) {
      const total = highlightMatches(query);
      return { total };
    },
  };
})();
