(function () {
  let term = null;
  let fitAddon = null;
  let onDataUnsub = null;
  let onExitUnsub = null;
  let started = false;

  const theme = {
    background: '#11111b',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    cursorAccent: '#11111b',
    selectionBackground: '#45475a88',
    black: '#11111b',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#cba6f7',
    cyan: '#89dceb',
    white: '#cdd6f4',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#cba6f7',
    brightCyan: '#94e2d5',
    brightWhite: '#ffffff',
  };

  function init(container) {
    if (term) return;
    term = new Terminal({
      theme,
      fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    term.onData((data) => window.api.terminalWrite(data));
  }

  function fit() {
    if (!term || !fitAddon) return;
    fitAddon.fit();
    window.api.terminalResize(term.cols, term.rows);
  }

  async function start(cwd) {
    if (!term) return;
    if (onDataUnsub) onDataUnsub();
    if (onExitUnsub) onExitUnsub();
    onDataUnsub = window.api.onTerminalData((data) => term.write(data));
    onExitUnsub = window.api.onTerminalExit(() => {
      started = false;
      term.writeln('\r\n\x1b[33m[сессия завершена]\x1b[0m');
    });
    await window.api.terminalKill();
    await window.api.terminalStart(cwd);
    term.reset();
    started = true;
    fit();
  }

  function runCommand(cmd) {
    const line = cmd.endsWith('\n') ? cmd : `${cmd}\n`;
    window.api.terminalWrite(line);
  }

  function clear() {
    term?.clear();
  }

  function writeln(text) {
    term?.writeln(text);
  }

  function isStarted() {
    return started;
  }

  window.TerminalPanel = { init, start, fit, runCommand, clear, writeln, isStarted };
})();
