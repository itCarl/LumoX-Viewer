/**
 * Monitor — passive listener for DMX-over-IP traffic on the local network.
 *
 * Binds the Art-Net (6454) and sACN/E1.31 (5568) UDP ports, parses every
 * datagram, and tracks one "source" per (protocol, sender IP, universe).
 *
 * Engine only — no I/O to the user. Subscribe to events to render:
 *   'packet' (info)          every parsed packet
 *   'source' (source)        first time a new source is seen
 *   'tick'   (sources[])     once per second, after FPS recompute
 *   'error'  (err)           socket error
 *
 * This separation lets the console view (or a future GUI) attach as a
 * pure subscriber without touching the network code.
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import * as artnet from './protocols/artnet.js';
import * as sacn   from './protocols/sacn.js';

export class Monitor extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.sacnUniverses=16] join multicast groups 1..N for sACN discovery
   * @param {number} [opts.staleMs=5000]      drop a source after this much silence
   */
  constructor({ sacnUniverses = 16, staleMs = 5000 } = {}) {
    super();
    this.sacnUniverses = sacnUniverses;
    this.staleMs = staleMs;
    /** @type {Map<string, object>} key = `${proto}|${ip}|${universe}` */
    this.sources = new Map();
    this._sockets = [];
    this._tickTimer = null;
  }

  start() {
    this._bindArtNet();
    this._bindSacn();
    this._tickTimer = setInterval(() => this._tick(), 1000);
    this._tickTimer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this._tickTimer);
    for (const s of this._sockets) { try { s.close(); } catch {} }
    this._sockets = [];
  }

  // --- sockets -----------------------------------------------------------

  _bindArtNet() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e) => this.emit('error', e));
    sock.on('message', (msg, rinfo) => this._onMessage(artnet.parse(msg), rinfo));
    sock.bind(artnet.ARTNET_PORT, () => {
      try { sock.setBroadcast(true); } catch {}
    });
    this._sockets.push(sock);
  }

  _bindSacn() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e) => this.emit('error', e));
    sock.on('message', (msg, rinfo) => this._onMessage(sacn.parse(msg), rinfo));
    sock.bind(sacn.SACN_PORT, () => {
      // Join multicast groups so we receive universes we never asked for.
      for (let u = 1; u <= this.sacnUniverses; u++) {
        try { sock.addMembership(sacn.multicastGroup(u)); } catch {}
      }
    });
    this._sockets.push(sock);
  }

  // --- ingest ------------------------------------------------------------

  _onMessage(info, rinfo) {
    if (!info) return; // not a packet we understand
    info.ip = rinfo.address;
    info.at = this._now();
    this.emit('packet', info);

    // Only DMX-bearing packets become tracked sources.
    if (info.universe == null || !info.data) return;

    const key = `${info.proto}|${info.ip}|${info.universe}`;
    let src = this.sources.get(key);
    if (!src) {
      src = {
        key, proto: info.proto, ip: info.ip, universe: info.universe,
        sourceName: info.sourceName || '',
        priority: info.priority ?? null,
        firstSeen: info.at, lastSeen: info.at,
        packets: 0, _count: 0, fps: 0,
        lastSeq: info.sequence ?? null, dropped: 0,
        _intervalEma: null, hz: 0,
        data: info.data,
      };
      this.sources.set(key, src);
      this.emit('source', src);
    }

    // Sequence-gap detection (both protocols use a rolling 0-255 counter).
    if (info.sequence != null && src.lastSeq != null) {
      const gap = (info.sequence - src.lastSeq + 256) & 0xff;
      if (gap > 1 && gap < 200) src.dropped += gap - 1;
    }

    // Refresh-rate (Hz): exponential moving average of inter-packet interval.
    // Far smoother and finer than counting packets per second.
    const dt = info.at - src.lastSeen;
    if (dt > 0 && dt < 2000) {
      const a = 0.1;
      src._intervalEma = src._intervalEma == null ? dt : src._intervalEma * (1 - a) + dt * a;
      src.hz = src._intervalEma > 0 ? 1000 / src._intervalEma : 0;
    }

    src.lastSeq    = info.sequence ?? src.lastSeq;
    src.sourceName = info.sourceName || src.sourceName;
    src.priority   = info.priority ?? src.priority;
    src.lastSeen   = info.at;
    src.data       = info.data;
    src.packets++;
    src._count++;
  }

  // --- bookkeeping -------------------------------------------------------

  _tick() {
    const now = this._now();
    for (const [key, src] of this.sources) {
      if (now - src.lastSeen > this.staleMs) { this.sources.delete(key); continue; }
      if (src._count === 0) { src.hz = 0; src._intervalEma = null; } // stream paused
      src.fps = src._count;
      src._count = 0;
    }
    this.emit('tick', this.list());
  }

  /** Active sources, sorted protocol → universe → ip. */
  list() {
    return [...this.sources.values()].sort((a, b) =>
      a.proto.localeCompare(b.proto) || a.universe - b.universe || a.ip.localeCompare(b.ip));
  }

  _now() { return Number(process.hrtime.bigint() / 1000000n); }
}
