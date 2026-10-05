// Stage 6: a minimal, dependency-free, deterministic ZIP writer used only
// by build/release.mjs. Writing our own ~150-line encoder (rather than
// shelling out to a platform `zip`/`tar` binary, whose availability,
// default flags, and mtime handling vary across macOS and Linux CI) is what
// makes "reproducible ordering/timestamps" (project.md) actually
// guaranteed, not merely likely: entries are always sorted by name, every
// entry's DOS timestamp is a fixed constant (1980-01-01, the ZIP format's
// own epoch), and every other header field below is a fixed constant too —
// so two builds from byte-identical input content always produce a
// byte-identical archive, on any platform Node runs on, with no external
// tool dependency. Uses only Node's built-in `zlib` (raw DEFLATE) and a
// small local CRC-32 implementation; nothing here is a general-purpose ZIP
// library (no STORED-method fallback, no Zip64, no extra fields) — only
// what this project's own, modestly sized release artifacts need.

import zlib from "node:zlib";

const DOS_EPOCH_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1; // 1980-01-01
const DOS_EPOCH_TIME = 0; // 00:00:00

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// `entries`: [{ name: string (POSIX-style relative path), data: Buffer }].
// Returns a single Buffer: the complete .zip file contents. Entries are
// sorted by `name` here (not trusted from caller order), so the archive's
// internal ordering never depends on filesystem read order, which is not
// itself guaranteed stable across platforms.
export function createDeterministicZip(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const { name, data } of sorted) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0, 6); // general purpose bit flag
    localHeader.writeUInt16LE(8, 8); // compression method: DEFLATE
    localHeader.writeUInt16LE(DOS_EPOCH_TIME, 10);
    localHeader.writeUInt16LE(DOS_EPOCH_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localChunks.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0, 8); // general purpose bit flag
    centralHeader.writeUInt16LE(8, 10); // compression method
    centralHeader.writeUInt16LE(DOS_EPOCH_TIME, 12);
    centralHeader.writeUInt16LE(DOS_EPOCH_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header

    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDirectorySize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const centralDirectoryOffset = offset;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(sorted.length, 8); // entries on this disk
  end.writeUInt16LE(sorted.length, 10); // total entries
  end.writeUInt32LE(centralDirectorySize, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, ...centralChunks, end]);
}

// Reads back a zip produced by createDeterministicZip above — used only by
// this project's own release tests (test/release.test.mjs), as a
// dependency-free substitute for shelling out to `unzip`. Walks the central
// directory (trusting only its own `createDeterministicZip` output shape:
// always DEFLATE, no Zip64, no data descriptors, no archive comment), not a
// general-purpose ZIP parser.
export function readZipEntries(zipBuffer) {
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= 0; i--) {
    if (zipBuffer.readUInt32LE(i) === eocdSignature) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("not a zip produced by createDeterministicZip: no end-of-central-directory record found");

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let pointer = centralDirectoryOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (zipBuffer.readUInt32LE(pointer) !== 0x02014b50) {
      throw new Error(`expected a central directory file header at offset ${pointer}`);
    }
    const compressedSize = zipBuffer.readUInt32LE(pointer + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(pointer + 24);
    const nameLength = zipBuffer.readUInt16LE(pointer + 28);
    const extraLength = zipBuffer.readUInt16LE(pointer + 30);
    const commentLength = zipBuffer.readUInt16LE(pointer + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(pointer + 42);
    const name = zipBuffer.toString("utf8", pointer + 46, pointer + 46 + nameLength);

    const localNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = zipBuffer.subarray(dataStart, dataStart + compressedSize);
    const data = zlib.inflateRawSync(compressed);
    if (data.length !== uncompressedSize) {
      throw new Error(`"${name}": inflated size ${data.length} does not match recorded size ${uncompressedSize}`);
    }
    entries.push({ name, data });

    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
