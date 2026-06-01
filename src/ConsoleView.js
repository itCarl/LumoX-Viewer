/**
 * ConsoleView — interactive terminal UI for a Monitor, in the spirit of
 * artnetview.com.
 *
 * Two modes, navigated by keyboard:
 *   LIST   — one row per active DMX source (protocol, universe, IP, FPS …).
 *            ↑/↓ select, Enter opens the channel browser.
 *   DETAIL — full 512-channel data grid for the selected source, live.
 *            ←/→ switch source, Esc/←Backspace back to the list.
 *
 * Global keys: h = dec/hex toggle, q / Ctrl+C = quit.
 *
 * Pure subscriber: reads Monitor events, writes stdout, reads stdin. A future
 * GUI would attach to the same Monitor the same way. When stdin is not a TTY
 * (piped output), it degrades to a non-interactive repainting table.
 */

import readline from 'node:readline';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', inv: '\x1b[7m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  magenta: '\x1b[35m', red: '\x1b[31m', gray: '\x1b[90m',
};

const PROTO_COLOR = { artnet: C.cyan, sacn: C.magenta };

export class ConsoleView {
  /**
   * @param {import('./Monitor.js').Monitor} monitor
   * @param {object} [opts]
   * @param {string} [opts.focus]  source key to open directly in DETAIL
   * @param {'dec'|'hex'} [opts.format='dec']
   */
  constructor(monitor, { focus = null, format = 'dec' } = {}) {
    this.monitor = monitor;
    this.format = format;
    this.startedAt = Date.now();

    this.mode = focus ? 'detail' : 'list';
    this.selectedKey = focus;     // track selection by key, not index (rows churn)
    this.sources = [];

    monitor.on('tick', (sources) => { this.sources = sources; this.render(); });
    monitor.on('error', (e) => process.stderr.write(`${C.red}socket error: ${e.message}${C.reset}\n`));

    this._initKeys();
  }

  // --- input -------------------------------------------------------------

  _initKeys() {
    if (!process.stdin.isTTY) { this.interactive = false; return; }
    this.interactive = true;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', (str, key) => this._onKey(str, key || {}));
  }

  _onKey(str, key) {
    if (key.ctrl && key.name === 'c') return this._quit();
    if (str === 'q') return this._quit();

    if (str === 'h') { this.format = this.format === 'hex' ? 'dec' : 'hex'; return this.render(); }

    if (this.mode === 'list') {
      if (key.name === 'up')   this._move(-1);
      if (key.name === 'down') this._move(+1);
      if (key.name === 'return') { if (this._current()) this.mode = 'detail'; }
    } else { // detail
      if (key.name === 'left')  this._move(-1);
      if (key.name === 'right') this._move(+1);
      if (key.name === 'escape' || key.name === 'backspace') this.mode = 'list';
    }
    this.render();
  }

  _move(delta) {
    if (this.sources.length === 0) return;
    let idx = this.sources.findIndex((s) => s.key === this.selectedKey);
    if (idx < 0) idx = 0;
    idx = Math.max(0, Math.min(this.sources.length - 1, idx + delta));
    this.selectedKey = this.sources[idx].key;
  }

  _current() {
    return this.sources.find((s) => s.key === this.selectedKey)
      || (this.sources.length ? (this.selectedKey = this.sources[0].key, this.sources[0]) : null);
  }

  _quit() {
    if (this.interactive) { try { process.stdin.setRawMode(false); } catch {} }
    this.monitor.stop();
    process.stdout.write(`${C.reset}\n`);
    process.exit(0);
  }

  // --- render ------------------------------------------------------------

  render() {
    const out = ['\x1b[2J\x1b[H']; // clear + home
    const uptime = Math.floor((Date.now() - this.startedAt) / 1000);
    out.push(`${C.bold}LumoX-Viewer${C.reset} ${C.dim}— DMX-over-IP network monitor${C.reset}`);
    out.push(`${C.gray}sources: ${this.sources.length}   uptime: ${uptime}s   listening: Art-Net :6454, sACN :5568${C.reset}`);
    out.push('');

    if (this.mode === 'detail' && this._current()) this._renderDetail(out);
    else { this.mode = 'list'; this._renderList(out); }

    process.stdout.write(out.join('\n') + '\n');
  }

  _renderList(out) {
    if (this.sources.length === 0) {
      out.push(`${C.dim}  …no Art-Net or sACN traffic detected yet.${C.reset}`);
    } else {
      out.push(`${C.dim}  ${[
        pad('', 1), pad('PROTO', 7), pad('UNIVERSE', 9), pad('SOURCE', 22),
        pad('IP', 16), padL('FPS', 4), padL('PRIO', 5),
        padL('PKTS', 9), padL('DROP', 6), padL('AGE', 5),
      ].join(' ')}${C.reset}`);
      if (!this.selectedKey) this._current();
      for (const s of this.sources) out.push(this._row(s, s.key === this.selectedKey));
    }
    out.push('', this.interactive
      ? `${C.dim}↑/↓ select · Enter open channels · h dec/hex · q quit${C.reset}`
      : `${C.dim}(non-interactive) Ctrl+C to quit${C.reset}`);
  }

  _row(s, sel) {
    const color = PROTO_COLOR[s.proto] || '';
    const age = Math.floor((this.monitor._now() - s.lastSeen) / 1000);
    const fps = s.fps > 0 ? `${C.green}${padL(String(s.fps), 4)}${C.reset}` : padL('0', 4);
    const drop = s.dropped > 0 ? `${C.red}${padL(String(s.dropped), 6)}${C.reset}` : padL('0', 6);
    const marker = sel ? `${C.yellow}▸${C.reset}` : ' ';
    const cells = [
      `${color}${pad(s.proto, 7)}${C.reset}`,
      pad(String(s.universe), 9),
      pad(trunc(s.sourceName || '—', 22), 22),
      pad(s.ip, 16), fps,
      padL(s.priority == null ? '—' : String(s.priority), 5),
      padL(String(s.packets), 9), drop, padL(`${age}s`, 5),
    ].join(' ');
    return `${marker} ${sel ? C.bold : ''}${cells}${C.reset}`;
  }

  _renderDetail(out) {
    const s = this._current();
    const color = PROTO_COLOR[s.proto] || '';
    const nonZero = s.data.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
    const idx = this.sources.findIndex((x) => x.key === s.key) + 1;

    out.push(`${color}${C.bold}${s.proto.toUpperCase()}${C.reset}  ` +
      `Universe ${C.bold}${s.universe}${C.reset}  @ ${s.ip}  ` +
      `${C.dim}"${s.sourceName || '—'}"${C.reset}`);
    out.push(`${C.gray}fps ${s.fps}   prio ${s.priority ?? '—'}   slots ${s.data.length}   ` +
      `active ${nonZero}   pkts ${s.packets}   dropped ${s.dropped}   ` +
      `[${idx}/${this.sources.length}]${C.reset}`);
    out.push('');

    const perRow = 16;
    // column header
    let head = '     ';
    for (let j = 0; j < perRow; j++) head += ' ' + C.gray + padL(String(j + 1), this.format === 'hex' ? 2 : 3) + C.reset;
    out.push(head);

    for (let i = 0; i < s.data.length; i += perRow) {
      const addr = `${C.gray}${padL(String(i + 1), 4)}${C.reset}`;
      const cells = [];
      for (let j = i; j < Math.min(i + perRow, s.data.length); j++) {
        const v = s.data[j];
        const str = this.format === 'hex' ? v.toString(16).padStart(2, '0') : padL(String(v), 3);
        cells.push(v === 0 ? `${C.dim}${str}${C.reset}`
          : v === 255 ? `${C.green}${str}${C.reset}`
          : `${C.yellow}${str}${C.reset}`);
      }
      out.push(`${addr}  ${cells.join(' ')}`);
    }

    out.push('', this.interactive
      ? `${C.dim}←/→ switch source · Esc back · h dec/hex · q quit${C.reset}`
      : `${C.dim}(non-interactive) Ctrl+C to quit${C.reset}`);
  }
}

function pad(s, n)  { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
function trunc(s, n){ s = String(s); return s.length <= n ? s : s.slice(0, n - 1) + '…'; }
