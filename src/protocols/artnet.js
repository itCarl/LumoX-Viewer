/**
 * Art-Net packet parser (receive-only subset, for monitoring).
 * Spec: https://art-net.org.uk/
 *
 * Parsed:
 *   ArtDmx       (OpCode 0x5000) — DMX data
 *   ArtPoll      (OpCode 0x2000) — discovery query
 *   ArtPollReply (OpCode 0x2100) — node announcement
 */

export const ARTNET_PORT = 6454;
const ARTNET_ID = Buffer.from('Art-Net\0', 'ascii'); // 8 bytes

export const OP_POLL       = 0x2000;
export const OP_POLL_REPLY = 0x2100;
export const OP_DMX        = 0x5000;

export const OP_NAMES = {
  [OP_POLL]:       'ArtPoll',
  [OP_POLL_REPLY]: 'ArtPollReply',
  [OP_DMX]:        'ArtDmx',
};

/**
 * Parse an incoming UDP datagram. Returns null if not Art-Net.
 * @param {Buffer} buf
 * @returns {{proto:'artnet', op:number, opName:string, ...}|null}
 */
export function parse(buf) {
  if (buf.length < 10) return null;
  if (buf.compare(ARTNET_ID, 0, 8, 0, 8) !== 0) return null;
  const op = buf.readUInt16LE(8);
  const opName = OP_NAMES[op] || `0x${op.toString(16).padStart(4, '0')}`;

  if (op === OP_DMX)        return { proto: 'artnet', op, opName, ...parseDmx(buf) };
  if (op === OP_POLL_REPLY) return { proto: 'artnet', op, opName, ...parsePollReply(buf) };
  return { proto: 'artnet', op, opName };
}

/** ArtDmx — universe + DMX slice. */
function parseDmx(buf) {
  if (buf.length < 18) return {};
  const sequence = buf.readUInt8(12);
  const physical = buf.readUInt8(13);
  const subUni   = buf.readUInt8(14);
  const net      = buf.readUInt8(15) & 0x7f;
  const universe = (net << 8) | subUni; // 15-bit port-address
  const length   = buf.readUInt16BE(16);
  const data     = Uint8Array.from(buf.subarray(18, 18 + Math.min(length, 512)));
  return { sequence, physical, universe, net, subUni, data };
}

/** ArtPollReply — node identity (subset useful for a source list). */
function parsePollReply(buf) {
  if (buf.length < 207) return {};
  return {
    nodeIp:    `${buf[10]}.${buf[11]}.${buf[12]}.${buf[13]}`,
    shortName: readCString(buf, 26, 18),
    longName:  readCString(buf, 44, 64),
    numPorts:  buf.readUInt16BE(172),
    swOut:     [buf[190], buf[191], buf[192], buf[193]],
  };
}

function readCString(buf, offset, max) {
  let end = offset;
  while (end < offset + max && buf[end] !== 0) end++;
  return buf.toString('ascii', offset, end);
}
