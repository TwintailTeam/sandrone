const { promisify } = require('node:util');
const zlib = require('node:zlib');
const { decodeText, formatBytes, basename } = require('./reader');
const { SIGNATURE: MINIDUMP_SIGNATURE, parseMinidump } = require('./minidump');
const { parseCrashContext, unpackBundle } = require('./unreal');
const { isIps, isLegacyReport, parseIps, parseLegacyReport } = require('./apple');
const { isZip, listEntries, readEntry } = require('./zip');
const { isEncryptedLog, decryptLog, describeLog } = require('./wuwa');
const { UNITY, UNREAL } = require('./engines');

const inflate = promisify(zlib.inflate);
const gzip = promisify(zlib.gzip);

const TYPES = {
    crashdump: 'Crash dump (.dmp: Unity or mihoyocrash_* crash.dmp, UEMinidump.dmp)',
    crash_context: 'Unreal crash context (CrashContext.runtime-xml)',
    crash_bundle: 'Unreal crash bundle (.uecrash / .ue4crash)',
    crash_folder: 'Zipped crash folder (.zip)',
    apple_crash: 'Apple crash report (.ips or macOS crash text)',
    wuwa_log: 'Wuthering Waves encrypted log (Client.log)',
};

const ENGINES = { unity: UNITY, unreal: UNREAL };

const UNREAL_ONLY_TYPES = new Set(['crash_context', 'crash_bundle', 'wuwa_log']);
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_DEPTH = 2;
const SNIFF_BYTES = 64 * 1024;
const ARCHIVE_CANDIDATE = /\.(dmp|mdmp|runtime-xml|xml|ips|crash|uecrash|ue4crash|zip)$/i;
const RESULT_ORDER = ['crash_context', 'crashdump', 'apple_crash'];

class AnalyzeError extends Error {
    name = 'AnalyzeError';
}

function isZlib(buffer) {
    return buffer.length > 2 && buffer[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(buffer[1]) && ((buffer[0] << 8) | buffer[1]) % 31 === 0;
}

function detectType(buffer) {
    if (buffer.length >= 4 && buffer.readUInt32LE(0) === MINIDUMP_SIGNATURE) { return 'crashdump'; }
    if (isZip(buffer)) { return 'crash_folder'; }
    if (isZlib(buffer)) { return 'crash_bundle'; }
    if (isEncryptedLog(buffer)) { return 'wuwa_log'; }
    const text = decodeText(buffer.subarray(0, SNIFF_BYTES));
    if (text.includes('<FGenericCrashContext')) { return 'crash_context'; }
    if (isIps(text) || isLegacyReport(text)) { return 'apple_crash'; }
    return null;
}

function parseSingle(type, buffer) {
    if (type === 'crashdump') { return parseMinidump(buffer); }
    if (type === 'crash_context') { return parseCrashContext(buffer); }
    return isIps(decodeText(buffer.subarray(0, SNIFF_BYTES))) ? parseIps(buffer) : parseLegacyReport(buffer);
}

async function analyzeBuffer(buffer, name, budget, depth) {
    const type = detectType(buffer);
    if (!type) { return [{ file: name, skipped: 'not a supported crash file (text logs are not analyzed)' }]; }

    if (type === 'crash_bundle' || type === 'crash_folder') {
        if (depth >= MAX_DEPTH) { return [{ file: name, skipped: 'nested archive is too deep' }]; }
        const entries = [];
        try {
            if (type === 'crash_bundle') {
                const unpacked = await inflate(buffer, { maxOutputLength: Math.max(1, budget.remaining) });
                budget.remaining -= unpacked.length;
                for (const file of unpackBundle(unpacked).files) { entries.push({ name: file.name, read: async () => file.data }); }
            } else {
                for (const entry of listEntries(buffer)) {
                    entries.push({ name: entry.name, read: ARCHIVE_CANDIDATE.test(entry.name) ? () => readEntry(buffer, entry, Math.max(1, budget.remaining)) : null });
                }
            }
        } catch (error) {
            const reason = error.code === 'ERR_BUFFER_TOO_LARGE' ? 'it unpacks to more than the size limit' : error.message;
            if (depth === 0) { throw new AnalyzeError(`Could not open ${name} as ${TYPES[type]}: ${reason}`); }
            return [{ file: name, skipped: `could not be opened: ${reason}` }];
        }

        const results = [{ file: name, container: type, contents: entries.map((entry) => entry.name) }];
        for (const entry of entries) {
            const path = `${name}/${entry.name}`;
            if (!entry.read) {
                results.push({ file: path, skipped: 'not analyzed (log, text or unsupported file)' });
                continue;
            }
            try {
                const data = await entry.read();
                budget.remaining -= type === 'crash_folder' ? data.length : 0;
                if (budget.remaining <= 0) { throw new AnalyzeError('the archive unpacks to more than the size limit'); }
                results.push(...await analyzeBuffer(data, path, budget, depth + 1));
            } catch (error) {
                if (error instanceof AnalyzeError) { throw error; }
                results.push({ file: path, skipped: `could not be read: ${error.message}` });
            }
        }
        return results;
    }

    try {
        return [{ file: name, result: parseSingle(type, buffer) }];
    } catch (error) {
        return [{ file: name, skipped: `could not be parsed as ${TYPES[type]}: ${error.message}` }];
    }
}

function redact(text, userNames) {
    let redacted = text.replace(/([\\/](?:Users|home|Documents and Settings)[\\/])([^\\/\r\n"'<>|]+)/gi, '$1<user>');
    for (const userName of userNames) {
        if (userName.length >= 3) { redacted = redacted.replace(new RegExp(userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<user>'); }
    }
    return redacted;
}

function mergeSummaries(parsed) {
    const ordered = [...parsed].sort((a, b) => RESULT_ORDER.indexOf(a.result.type) - RESULT_ORDER.indexOf(b.result.type));
    const pick = (key) => ordered.map((entry) => entry.result.summary[key]).find((value) => value) ?? null;
    return {
        exception: pick('exception'),
        detail: pick('detail'),
        location: pick('location'),
        faultHint: pick('faultHint'),
        os: pick('os'),
        engineVersion: pick('engineVersion'),
        backend: pick('backend'),
        process: pick('process'),
        gpu: pick('gpu'),
        notes: [...new Set(ordered.flatMap((entry) => entry.result.summary.notes ?? []))],
    };
}

function renderSummary(summary, engine) {
    const rows = [
        ['Crash', summary.exception],
        ['Detail', summary.detail],
        ['Location', summary.location],
        ['Faulting module', summary.faultHint],
        ['Engine', summary.engineVersion ?? engine],
        ['Scripting backend', summary.backend],
        ['Process', summary.process],
        ['OS', summary.os],
        ['GPU', summary.gpu],
        ...summary.notes.map((note) => ['Note', note]),
    ].filter(([, value]) => value);
    return ['Summary', ...rows.map(([label, value]) => `  ${label.padEnd(18)} ${value}`), ''];
}

function renderReport({ fileName, size, selectedType, selectedEngine, detectedType, entries, warnings, summary, engine }) {
    const lines = [
        'Crash analysis report',
        `File: ${fileName} (${formatBytes(size)})`,
        `Selected: ${TYPES[selectedType]}, ${selectedEngine}`,
        `Detected: ${detectedType ? TYPES[detectedType] : 'unknown'}`,
        `Generated: ${new Date().toISOString()}`,
        'Personal data (user names, machine/account IDs, login tokens, user folders) is redacted.',
        'Frames are not symbolized: module+offset values need the matching PDB/dSYM/.sym files to turn into function names.',
        '',
    ];
    lines.push(...renderSummary(summary, engine));
    if (warnings.length) { lines.push('Warnings', ...warnings.map((warning) => `  ! ${warning}`), ''); }

    for (const entry of entries) {
        if (entry.container) {
            lines.push(`=== ${entry.file} (${TYPES[entry.container]}) ===`, ...entry.contents.map((name) => `  ${name}`), '');
            continue;
        }
        if (entry.skipped) {
            lines.push(`=== ${entry.file} ===`, `  skipped: ${entry.skipped}`, '');
            continue;
        }
        lines.push(`=== ${entry.file} (${entry.result.kind}) ===`);
        for (const warning of entry.result.warnings) { lines.push(`  ! ${warning}`); }
        for (const section of entry.result.sections) {
            lines.push('', `## ${section.title}`, ...section.lines.map((line) => `  ${line}`));
        }
        lines.push('');
    }
    return lines.join('\n');
}

function decryptWuwa(buffer, fileName, selectedEngine) {
    const decrypted = decryptLog(buffer);
    const info = describeLog(decrypted.toString('utf8'));
    const warnings = selectedEngine === UNITY ? ['Wuthering Waves runs on Unreal Engine, not Unity.'] : [];
    if (!info.opened) { warnings.push('The decrypted text does not start with "Log file open", so the encryption may have changed and the output could be garbage.'); }
    return {
        detectedType: 'wuwa_log',
        engine: UNREAL,
        kinds: [TYPES.wuwa_log],
        summary: { ...info, size: formatBytes(buffer.length) },
        warnings,
        output: decrypted,
        outputName: `${basename(fileName).replace(/\.[^.]+$/, '') || 'Client'}_decrypted.log`,
    };
}

async function fitOutput(result, limit) {
    if (!limit || result.output.length <= limit) { return result; }
    const compressed = await gzip(result.output, { level: zlib.constants.Z_BEST_COMPRESSION });
    if (compressed.length > limit) { throw new AnalyzeError(`The result is ${formatBytes(compressed.length)} even when compressed, which is over this server's ${formatBytes(limit)} upload limit.`); }
    return { ...result, output: compressed, outputName: `${result.outputName}.gz`, compressed: true };
}

async function analyze(data, fileName, options) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return fitOutput(await analyzeFile(buffer, fileName, options), options.outputLimit);
}

async function analyzeFile(buffer, fileName, { type: selectedType, engine: engineChoice }) {
    const selectedEngine = ENGINES[engineChoice] ?? engineChoice;
    const detectedType = detectType(buffer);
    if (detectedType === 'wuwa_log') { return decryptWuwa(buffer, fileName, selectedEngine); }
    if (selectedType === 'wuwa_log' && !detectedType) {
        const head = decodeText(buffer.subarray(0, SNIFF_BYTES));
        throw new AnalyzeError(/^\s*Log file open/.test(head) ? `${basename(fileName)} is already a plain, unencrypted log.` : `${basename(fileName)} is not an encrypted Wuthering Waves log (it should start with the bytes 00 54 50).`);
    }
    if (!detectedType) {
        throw new AnalyzeError(`${basename(fileName)} is not a crash file this command understands. Supported: ${Object.values(TYPES).join('; ')}. Plain .txt/.log files are not analyzed.`);
    }

    const warnings = [];
    if (detectedType !== selectedType) { warnings.push(`You picked "${TYPES[selectedType]}", but the file is: ${TYPES[detectedType]}. It was analyzed as what it actually is.`); }
    if (selectedEngine === UNITY && UNREAL_ONLY_TYPES.has(selectedType)) { warnings.push(`${TYPES[selectedType]} files are only produced by Unreal Engine, not Unity.`); }

    const entries = await analyzeBuffer(buffer, basename(fileName), { remaining: MAX_UNPACKED_BYTES }, 0);
    const parsed = entries.filter((entry) => entry.result);
    if (!parsed.length) {
        const reasons = entries.filter((entry) => entry.skipped).map((entry) => `${entry.file}: ${entry.skipped}`);
        throw new AnalyzeError(`Nothing in ${basename(fileName)} could be analyzed.${reasons.length ? `\n${reasons.slice(0, 5).join('\n')}` : ''}`);
    }

    const detectedEngine = parsed.map((entry) => entry.result.engine).find(Boolean) ?? null;
    if (detectedEngine && detectedEngine !== selectedEngine) { warnings.push(`You picked ${selectedEngine}, but this crash comes from ${detectedEngine}.`); }
    if (!detectedEngine) { warnings.push(`The engine could not be confirmed from the file; assuming ${selectedEngine} as selected.`); }

    const userNames = [...new Set(parsed.flatMap((entry) => [entry.result.userName, ...(entry.result.userNames ?? [])]).filter(Boolean))];
    const summary = mergeSummaries(parsed);
    const report = redact(renderReport({ fileName: basename(fileName), size: buffer.length, selectedType, selectedEngine, detectedType, entries, warnings, summary, engine: detectedEngine ?? selectedEngine }), userNames);
    const redactSummary = Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, typeof value === 'string' ? redact(value, userNames) : Array.isArray(value) ? value.map((item) => redact(item, userNames)) : value]));

    return {
        detectedType,
        engine: detectedEngine ?? selectedEngine,
        kinds: [...new Set(parsed.map((entry) => entry.result.kind))],
        analyzedFiles: parsed.length,
        totalFiles: entries.filter((entry) => !entry.container).length,
        summary: redactSummary,
        warnings: warnings.map((warning) => redact(warning, userNames)),
        output: Buffer.from(report, 'utf8'),
        outputName: `crash-report-${basename(fileName).replace(/\.[^.]+$/, '') || 'file'}.txt`,
    };
}

module.exports = { TYPES, ENGINES, AnalyzeError, analyze };
