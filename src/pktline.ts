// pkt-line framing for the git smart-HTTP protocols, and the sideband
// multiplexing that carries pack data inside fetch and push responses.
//
// A pkt-line is 4 lowercase hex digits naming the total length (header +
// payload), then the payload. Length 0 is a flush packet, 1 a delim packet,
// 2 a response-end packet. The largest packet is 65520 bytes (git's
// LARGE_PACKET_MAX). Sideband packets are pkt-lines whose payload starts
// with a band byte: 1 = data, 2 = progress, 3 = error.

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** The most pack bytes one sideband packet carries: payload minus the band byte. */
export const SIDEBAND_CHUNK = PKT_LINE_MAX_PAYLOAD - 1;

export type PacketKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Packet {
  readonly kind: PacketKind;
  /** The payload for data packets (empty for control packets). */
  readonly payload: Buffer;
  /** Byte offset just past this packet in the source buffer. */
  readonly end: number;
}

export class PktLineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PktLineError';
  }
}

function toBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Encode one data packet: 4 hex length bytes then the payload. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = toBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new PktLineError(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a mixed sequence; 'flush' | 'delim' | 'response-end' are control packets. */
export function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Decode pkt-lines from the start of `buffer`. Stops at the first packet it
 * cannot complete (truncated tail) or at `stopAfterFlush`'s first flush
 * packet, and reports how many bytes were consumed, so a caller with trailing
 * raw bytes (a pack after a receive-pack command list) can find them.
 */
export function decodePktLines(
  buffer: Buffer,
  options: { stopAfterFlush?: boolean } = {},
): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) break;
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) {
      throw new PktLineError(`invalid pkt-line length ${JSON.stringify(header)} at offset ${offset}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), end: offset + 4 });
      offset += 4;
      if (options.stopAfterFlush === true) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0), end: offset + 4 });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0), end: offset + 4 });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX) {
      throw new PktLineError(`invalid pkt-line length ${length} at offset ${offset}`);
    }
    if (offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length), end: offset + length });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** The decoded text of every data packet, control packets dropped. */
export function packetLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

/**
 * Wrap `data` in sideband packets of the given band, chunked to the packet
 * maximum. Returns the concatenated pkt-line stream (no trailing flush; the
 * caller adds framing around it).
 */
export function sidebandEncode(band: 1 | 2 | 3, data: Buffer): Buffer {
  if (data.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, data.length));
    const payload = Buffer.allocUnsafe(chunk.length + 1);
    payload[0] = band;
    chunk.copy(payload, 1);
    parts.push(encodePktLine(payload));
  }
  return Buffer.concat(parts);
}
