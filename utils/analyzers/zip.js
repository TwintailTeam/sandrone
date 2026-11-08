const { promisify } = require('node:util');
const zlib = require('node:zlib');
const { Reader } = require('./reader');

const inflateRaw = promisify(zlib.inflateRaw);

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_EXTRA_ID = 0x0001;
const MAX_COMMENT = 0xffff;
const STORED = 0;
const DEFLATED = 8;
const FLAG_ENCRYPTED = 1;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

const isZip = (buffer) => buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_SIGNATURE;

function findEnd(reader, buffer) {
    for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - MAX_COMMENT); offset--) {
        if (reader.u32(offset) === END_SIGNATURE) { return offset; }
    }
    throw new Error('zip end record not found (the archive is truncated)');
}

function listEntries(buffer) {
    const reader = new Reader(buffer);
    const end = findEnd(reader, buffer);
    let count = reader.u16(end + 10);
    let directory = reader.u32(end + 16);

    if ((count === U16_MAX || directory === U32_MAX) && end >= 20 && reader.u32(end - 20) === ZIP64_LOCATOR_SIGNATURE) {
        const zip64End = Number(reader.u64(end - 20 + 8));
        if (reader.u32(zip64End) !== ZIP64_END_SIGNATURE) { throw new Error('broken ZIP64 end record'); }
        count = Number(reader.u64(zip64End + 32));
        directory = Number(reader.u64(zip64End + 48));
    }

    const entries = [];
    let offset = directory;
    for (let i = 0; i < count; i++) {
        if (reader.u32(offset) !== CENTRAL_SIGNATURE) { throw new Error('broken zip central directory'); }
        const flags = reader.u16(offset + 8);
        const method = reader.u16(offset + 10);
        let compressedSize = reader.u32(offset + 20);
        let size = reader.u32(offset + 24);
        const nameLength = reader.u16(offset + 28);
        const extraLength = reader.u16(offset + 30);
        const commentLength = reader.u16(offset + 32);
        let localOffset = reader.u32(offset + 42);
        const name = reader.bytes(offset + 46, nameLength).toString('utf8');

        let extra = offset + 46 + nameLength;
        const extraEnd = extra + extraLength;
        while (extra + 4 <= extraEnd) {
            const id = reader.u16(extra);
            const length = reader.u16(extra + 2);
            if (id === ZIP64_EXTRA_ID) {
                let field = extra + 4;
                if (size === U32_MAX) { size = Number(reader.u64(field)); field += 8; }
                if (compressedSize === U32_MAX) { compressedSize = Number(reader.u64(field)); field += 8; }
                if (localOffset === U32_MAX) { localOffset = Number(reader.u64(field)); }
            }
            extra += 4 + length;
        }

        if (!name.endsWith('/')) { entries.push({ name, flags, method, compressedSize, size, localOffset }); }
        offset = extraEnd + commentLength;
    }
    return entries;
}

async function readEntry(buffer, entry, maxSize) {
    if (entry.flags & FLAG_ENCRYPTED) { throw new Error('entry is password protected'); }
    if (entry.size > maxSize) { throw new Error(`entry is too large to unpack (${entry.size} bytes)`); }
    const reader = new Reader(buffer);
    if (reader.u32(entry.localOffset) !== LOCAL_SIGNATURE) { throw new Error('broken local file header'); }
    const start = entry.localOffset + 30 + reader.u16(entry.localOffset + 26) + reader.u16(entry.localOffset + 28);
    const data = reader.bytes(start, entry.compressedSize);
    if (entry.method === STORED) { return data; }
    if (entry.method === DEFLATED) { return inflateRaw(data, { maxOutputLength: maxSize }); }
    throw new Error(`unsupported zip compression method ${entry.method}`);
}

module.exports = { isZip, listEntries, readEntry };
