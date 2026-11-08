const ENCRYPTED_HEADER = [0x00, 0x54, 0x50];
const KEY_ODD = 0xa5;
const KEY_EVEN = 0xef;

const isEncryptedLog = (buffer) => buffer.length >= 3 && ENCRYPTED_HEADER.every((byte, i) => buffer[i] === byte);

function decryptLog(buffer) {
    const output = Buffer.allocUnsafe(buffer.length);
    for (let i = 0; i < buffer.length; i++) { output[i] = buffer[i] ^ (buffer[i] & 1 ? KEY_ODD : KEY_EVEN); }
    return output;
}

function describeLog(text) {
    const lines = text.split('\n');
    return {
        lineCount: lines.length,
        opened: text.match(/^﻿?Log file open, \[([^\]]+)\]/)?.[1] ?? null,
        closed: text.match(/Log file closed, \[([^\]]+)\]/)?.[1] ?? null,
        errors: lines.filter((line) => /\b(Error|Fatal):/.test(line)).length,
        warnings: lines.filter((line) => /\bWarning:/.test(line)).length,
    };
}

module.exports = { isEncryptedLog, decryptLog, describeLog };
