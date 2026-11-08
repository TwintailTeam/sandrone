class Reader {
    constructor(buffer) {
        this.buffer = buffer;
    }

    check(offset, size) {
        if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset + size > this.buffer.length) {
            throw new RangeError(`read of ${size} bytes at 0x${Number(offset).toString(16)} is outside the file`);
        }
    }

    u8(offset) {
        this.check(offset, 1);
        return this.buffer.readUInt8(offset);
    }

    u16(offset) {
        this.check(offset, 2);
        return this.buffer.readUInt16LE(offset);
    }

    u32(offset) {
        this.check(offset, 4);
        return this.buffer.readUInt32LE(offset);
    }

    i32(offset) {
        this.check(offset, 4);
        return this.buffer.readInt32LE(offset);
    }

    u64(offset) {
        this.check(offset, 8);
        return this.buffer.readBigUInt64LE(offset);
    }

    bytes(offset, size) {
        this.check(offset, size);
        return this.buffer.subarray(offset, offset + size);
    }
}

const hex = (value, width = 0) => `0x${value.toString(16).padStart(width, '0')}`;

function decodeText(buffer) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) { return buffer.subarray(2).toString('utf16le'); }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) { return Buffer.from(buffer.subarray(2)).swap16().toString('utf16le'); }
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) { return buffer.subarray(3).toString('utf8'); }
    return buffer.toString('utf8');
}

function formatBytes(bytes) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = Number(bytes);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}

const basename = (path) => path.split(/[\\/]/).pop();

module.exports = { Reader, hex, decodeText, formatBytes, basename };
