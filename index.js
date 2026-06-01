#!/usr/bin/env node
/**
 * LumoX-Viewer — entry point.
 *
 * Passively monitors Art-Net (UDP 6454) and sACN/E1.31 (UDP 5568) on the
 * local network, similar to artnetview.com.
 *
 * Three front-ends, all pure subscribers to the same Monitor engine:
 *   (default) ConsoleView — interactive terminal UI
 *   --gui     WebServer    — minimal browser GUI (left list · grid · graph)
 *   --raw     packet log   — every parsed packet, one line each
 *
 * Usage:
 *   node index.js [options]
 *
 * Options:
 *   --gui [port]      launch the browser GUI (default port 7878)
 *   --universes <n>   sACN multicast universes to join, 1..n   (default 16)
 *   --focus <key>     open straight into a source's channel grid
 *                       e.g. "artnet|192.168.1.50|0" or "sacn|10.0.0.7|1"
 *   --hex             show channel values in hex (console)
 *   --raw             log every parsed packet instead of a live view
 */

import { Monitor } from './src/Monitor.js';
import { ConsoleView } from './src/ConsoleView.js';
import { WebServer } from './src/WebServer.js';

const args = parseArgs(process.argv.slice(2));

const monitor = new Monitor({
  sacnUniverses: Number(args.universes) || 16,
});

let web = null;

if (args.raw) {
  monitor.on('packet', (p) => {
    const u = p.universe != null ? ` U${p.universe}` : '';
    const n = p.sourceName ? ` "${p.sourceName}"` : '';
    process.stdout.write(`${p.proto.padEnd(6)} ${p.opName.padEnd(13)} ${p.ip}${u}${n}\n`);
  });
  monitor.on('error', (e) => process.stderr.write(`socket error: ${e.message}\n`));
} else if (args.gui) {
  web = new WebServer(monitor, { port: Number(args.guiPort) || 7878 }).start();
  monitor.on('error', (e) => process.stderr.write(`socket error: ${e.message}\n`));
} else {
  new ConsoleView(monitor, { focus: args.focus, format: args.hex ? 'hex' : 'dec' });
}

monitor.start();
process.stdout.write('LumoX-Viewer listening — Art-Net :6454, sACN :5568 …\n');

process.on('SIGINT', () => {
  web?.stop();
  monitor.stop();
  process.stdout.write('\nstopped.\n');
  process.exit(0);
});

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hex') out.hex = true;
    else if (a === '--raw') out.raw = true;
    else if (a === '--gui') {
      out.gui = true;
      if (argv[i + 1] && /^\d+$/.test(argv[i + 1])) out.guiPort = argv[++i];
    }
    else if (a === '--universes') out.universes = argv[++i];
    else if (a === '--focus') out.focus = argv[++i];
  }
  return out;
}
