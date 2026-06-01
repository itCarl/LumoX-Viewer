/**
 * sACN E1.31 data-packet parser (receive-only, for monitoring).
 * Spec: ANSI E1.31-2018.
 */

export const SACN_PORT = 5568;

const PREAMBLE_SIZE           = 0x0010;
const ACN_PACKET_ID           = Buffer.from('ASC-E1.17\0\0\0', 'ascii'); // 12 bytes
const VECTOR_ROOT_E131_DATA   = 0x00000004;
const VECTOR_E131_DATA_PACKET = 0x00000002;

/** Multicast group address for a universe (1-63999). */
export function multicastGroup(universe) {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

/**
 * Parse an incoming sACN data packet. Returns null on mismatch.
 * @param {Buffer} buf
 * @returns {{proto:'sacn', ...}|null}
 */
export function parse(buf) {
  if (buf.length < 126) return null;
  if (buf.readUInt16BE(0) !== PREAMBLE_SIZE) return null;
  if (buf.compare(ACN_PACKET_ID, 0, 12, 4, 16) !== 0) return null;
  if (buf.readUInt32BE(18) !== VECTOR_ROOT_E131_DATA) return null;
  if (buf.readUInt32BE(40) !== VECTOR_E131_DATA_PACKET) return null;

  const cid        = Buffer.from(buf.subarray(22, 38));
  const sourceName = readCString(buf, 44, 64);
  const priority   = buf.readUInt8(108);
  const syncAddr   = buf.readUInt16BE(109);
  const sequence   = buf.readUInt8(111);
  const options    = buf.readUInt8(112);
  const universe   = buf.readUInt16BE(113);

  const dmpStart  = 115;
  const propCount = buf.readUInt16BE(dmpStart + 8);
  const dmxLen    = Math.max(0, propCount - 1); // minus start code
  const data      = Uint8Array.from(buf.subarray(dmpStart + 11, dmpStart + 11 + dmxLen));

  return {
    proto: 'sacn', opName: 'E1.31 Data',
    cid: cid.toString('hex'),
    sourceName, priority, syncAddr, sequence, options, universe, data,
  };
}

function readCString(buf, offset, max) {
  let end = offset;
  while (end < offset + max && buf[end] !== 0) end++;
  return buf.toString('utf8', offset, end);
}
