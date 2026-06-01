# LumoX-Viewer

See what DMX signals are floating around the network.

A passive monitor for DMX-over-IP traffic, in the spirit of
[artnetview.com](https://artnetview.com). It listens for **Art-Net**
(UDP 6454) and **sACN / E1.31** (UDP 5568) and shows a live list of every
source on the network — protocol, universe, source name, IP, frame rate,
priority, packet/drop counts — plus an optional 512-channel data grid.

Two front-ends — a **browser GUI** and an **interactive terminal UI** — both
pure subscribers to the same capture engine (see Architecture).

## Run

```bash
node index.js                 # interactive terminal: source list → channel browser
node index.js --gui           # browser GUI at http://127.0.0.1:7878
node index.js --gui 9000      # …on a custom port
node index.js --hex           # terminal: channel values in hex
node index.js --raw           # log every parsed packet (non-interactive firehose)
node index.js --universes 64  # join sACN multicast groups 1..64
node index.js --focus "artnet|192.168.1.50|0"   # open straight into a universe
```

## GUI

`--gui` serves a minimal three-pane page (no build step, no dependencies —
plain HTML/CSS/JS streamed over Server-Sent Events):

```
┌──────────┬───────────────────────┬──────────────┐
│ SOURCES  │ CHANNELS (16-wide grid)│ GRAPH        │
│ Art-Net  │  live bars + values    │ selected ch. │
│ sACN     │  DEC / % / HEX         │ history      │
│ click →  │  click a cell → graph  │ INFO panel   │
└──────────┴───────────────────────┴──────────────┘
```

- **Left** — every source on the network; click to focus.
- **Center** — its 512 channels, live, with a fill-bar per cell. Click a
  cell to graph that channel. Toggle DEC / percent / HEX.
- **Right** — rolling history graph of the selected channel (~300 frames)
  plus source info (fps, priority, sequence, packets, dropped, active count).

### Keys

| Mode | Key | Action |
|---|---|---|
| List | ↑ / ↓ | select a source |
| List | Enter | open its 512-channel grid |
| Detail | ← / → | switch to prev/next source |
| Detail | Esc / Backspace | back to the list |
| any | `h` | toggle decimal / hex |
| any | `q` / Ctrl+C | quit |

The **detail** view shows all 512 channels (16 per row, address-labelled),
updating live — dim = 0, yellow = active, green = full (255).

`--focus` takes a source key as shown by the table: `proto|ip|universe`,
e.g. `sacn|10.0.0.7|1`. When stdout is piped (no TTY), the UI degrades to a
plain repainting table.

> sACN sources are discovered by joining multicast groups `1..N`
> (`--universes`, default 16). Unicast sACN and all Art-Net are caught
> regardless.

## Architecture

```
UDP 6454 ─┐                  ┌─ ConsoleView   (terminal)
          ├─ Monitor (events)┼─ WebServer ──→ browser (SSE)
UDP 5568 ─┘                  └─ (future view)
```

| File | Purpose |
|---|---|
| `index.js` | CLI entry — arg parsing, wires Monitor → chosen view |
| `src/Monitor.js` | Engine: binds sockets, parses, tracks sources, emits events |
| `src/ConsoleView.js` | Interactive terminal UI (list + channel grid) |
| `src/WebServer.js` | HTTP + SSE bridge for the browser GUI |
| `src/protocols/artnet.js` | Art-Net parser (ArtDmx / ArtPoll / ArtPollReply) |
| `src/protocols/sacn.js` | sACN E1.31 data-packet parser |
| `web/` | GUI page — `index.html`, `style.css`, `app.js` |

The `Monitor` emits `packet`, `source`, `tick`, and `error` events. Every
front-end — terminal, browser, anything future — attaches as a pure
subscriber, never touching the capture code.
