/**
 * WebServer — a minimal GUI front-end for a Monitor.
 *
 * Serves a static page (web/) and streams live data to the browser over
 * Server-Sent Events (SSE) — no WebSocket library, zero dependencies.
 *
 * Endpoints:
 *   GET /                 the UI
 *   GET /app.js,/style.css static assets
 *   GET /events           SSE stream:
 *                           event: sources  (1 Hz)  — list metadata
 *                           event: frame    (~30 Hz)— focused source data
 *   GET /focus?key=...    select which source the frame stream follows
 *
 * Like ConsoleView, this is a pure subscriber to the Monitor: it adds the
 * GUI without touching the capture engine.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const FRAME_MIN_MS = 33; // ~30 Hz cap on the focused-source stream

export class WebServer {
  /**
   * @param {import('./Monitor.js').Monitor} monitor
   * @param {object} [opts]
   * @param {number} [opts.port=7878]
   * @param {string} [opts.host='127.0.0.1']
   */
  constructor(monitor, { port = 7878, host = '127.0.0.1' } = {}) {
    this.monitor = monitor;
    this.port = port;
    this.host = host;
    this.clients = new Set();
    this.focusKey = null;
    this._lastFrameAt = 0;

    monitor.on('tick', (sources) => this._broadcastSources(sources));
    monitor.on('packet', (p) => this._maybeSendFrame(p));

    this.server = http.createServer((req, res) => this._route(req, res));
  }

  start() {
    this.server.listen(this.port, this.host, () => {
      const url = `http://${this.host}:${this.port}`;
      process.stdout.write(`LumoX-Viewer GUI → ${url}\n`);
    });
    // keep-alive heartbeat so proxies/idle don't drop the SSE stream
    this._hb = setInterval(() => {
      for (const res of this.clients) res.write(': ping\n\n');
    }, 15000);
    this._hb.unref?.();
    return this;
  }

  stop() {
    clearInterval(this._hb);
    for (const res of this.clients) { try { res.end(); } catch {} }
    this.clients.clear();
    this.server.close();
  }

  // --- routing -----------------------------------------------------------

  _route(req, res) {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/events') return this._sse(req, res);
    if (u.pathname === '/focus')  return this._focus(u, res);
    return this._static(u.pathname, res);
  }

  _static(pathname, res) {
    const name = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.join(WEB_DIR, path.normalize(name));
    if (!file.startsWith(WEB_DIR)) { res.writeHead(403).end(); return; } // path traversal guard
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
  }

  _focus(u, res) {
    const key = u.searchParams.get('key') || null;
    this.focusKey = key && this.monitor.sources.has(key) ? key : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ focus: this.focusKey }));
  }

  _sse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    this._broadcastSources(this.monitor.list()); // prime immediately
    req.on('close', () => this.clients.delete(res));
  }

  // --- push --------------------------------------------------------------

  _broadcastSources(sources) {
    const meta = sources.map((s) => ({
      key: s.key, proto: s.proto, universe: s.universe, ip: s.ip,
      sourceName: s.sourceName, priority: s.priority,
      hz: s.hz, fps: s.fps, packets: s.packets, dropped: s.dropped,
      ageMs: this.monitor._now() - s.lastSeen, slots: s.data.length,
    }));
    this._send('sources', meta);
  }

  _maybeSendFrame(p) {
    if (!this.focusKey) return;
    const src = this.monitor.sources.get(this.focusKey);
    if (!src) return;
    const now = this.monitor._now();
    if (now - this._lastFrameAt < FRAME_MIN_MS) return;
    this._lastFrameAt = now;
    this._send('frame', {
      key: src.key, universe: src.universe, hz: src.hz, fps: src.fps, packets: src.packets,
      dropped: src.dropped, priority: src.priority, sequence: src.lastSeq,
      data: Buffer.from(src.data).toString('base64'),
    });
  }

  _send(event, payload) {
    if (this.clients.size === 0) return;
    const chunk = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.clients) res.write(chunk);
  }
}
