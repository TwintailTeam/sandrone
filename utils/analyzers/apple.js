const { hex, decodeText, basename } = require('./reader');
const { moduleHint, detectFromModules } = require('./engines');

const LEGACY_MARKER = 'Incident Identifier:';

function isIps(text) {
    const newline = text.indexOf('\n');
    if (newline <= 0) { return false; }
    try {
        const header = JSON.parse(text.slice(0, newline));
        return typeof header === 'object' && header !== null && 'bug_type' in header;
    } catch {
        return false;
    }
}

const isLegacyReport = (text) => text.trimStart().startsWith(LEGACY_MARKER);

function frameLine(frame, images, index) {
    const image = images[frame.imageIndex];
    const name = image?.name ?? (image?.path ? basename(image.path) : '???');
    const symbol = frame.symbol ? `  ${frame.symbol}${frame.symbolLocation ? ` + ${frame.symbolLocation}` : ''}` : '';
    const source = frame.sourceFile ? `  (${frame.sourceFile}${frame.sourceLine ? `:${frame.sourceLine}` : ''})` : '';
    return `${String(index).padStart(3)}  ${name.padEnd(32)} +${hex(frame.imageOffset ?? 0)}${symbol}${source}`;
}

function parseIps(buffer) {
    const text = decodeText(buffer);
    const newline = text.indexOf('\n');
    const header = JSON.parse(text.slice(0, newline));
    let body;
    try {
        body = JSON.parse(text.slice(newline + 1));
    } catch (error) {
        throw new Error(`the .ips header is valid but its report body is not JSON (${error.message})`);
    }

    const images = Array.isArray(body.usedImages) ? body.usedImages : [];
    const threads = Array.isArray(body.threads) ? body.threads : [];
    const crashedIndex = Number.isInteger(body.faultingThread) ? body.faultingThread : threads.findIndex((thread) => thread.triggered);
    const crashed = threads[crashedIndex];
    const exception = body.exception ?? {};
    const exceptionName = [exception.type, exception.signal && `(${exception.signal})`].filter(Boolean).join(' ') || body.termination?.indicator || 'unknown';
    const modules = images.map((image) => ({ name: image.path ?? image.name ?? '', base: BigInt(image.base ?? 0), size: Number(image.size ?? 0), version: null }));
    const detection = detectFromModules([{ name: body.procPath ?? body.procName ?? '' }, ...modules]);
    const topFrame = crashed?.frames?.[0];
    const topImage = topFrame ? images[topFrame.imageIndex] : null;
    const location = topFrame ? `${topImage?.name ?? '???'}+${hex(topFrame.imageOffset ?? 0)}${topFrame.symbol ? ` (${topFrame.symbol})` : ''}` : null;
    const os = [body.osVersion?.train, body.osVersion?.build && `(${body.osVersion.build})`].filter(Boolean).join(' ') || header.os_version || null;
    const asi = body.asi ? Object.entries(body.asi).flatMap(([image, messages]) => (Array.isArray(messages) ? messages : [messages]).map((message) => `${image}: ${message}`)) : [];

    const sections = [{
        title: 'Report',
        lines: [
            `Type: Apple crash report (.ips, bug type ${header.bug_type})`,
            `Process: ${body.procName ?? header.app_name ?? 'unknown'}${body.bundleInfo?.CFBundleShortVersionString ? ` ${body.bundleInfo.CFBundleShortVersionString}` : ''}`,
            body.bundleInfo?.CFBundleIdentifier ? `Bundle: ${body.bundleInfo.CFBundleIdentifier}` : null,
            `OS: ${os ?? 'unknown'}`,
            body.cpuType ? `CPU: ${body.cpuType}` : null,
            body.modelCode ? `Model: ${body.modelCode}` : null,
            body.captureTime ? `Captured: ${body.captureTime}` : null,
            `Engine: ${detection.engine ?? 'not detected from images'}${detection.version ? `, ${detection.version}` : ''}`,
        ].filter(Boolean),
    }, {
        title: 'Exception',
        lines: [
            exceptionName,
            exception.subtype ? `Subtype: ${exception.subtype}` : null,
            exception.codes ? `Codes: ${exception.codes}` : null,
            body.termination ? `Termination: ${[body.termination.namespace, body.termination.indicator].filter(Boolean).join(', ')}` : null,
            ...asi.map((line) => `Application specific: ${line}`),
            `Crashed thread: ${crashedIndex}${crashed?.name ? ` (${crashed.name})` : ''}${crashed?.queue ? ` queue ${crashed.queue}` : ''}`,
            location ? `Location: ${location}` : null,
            topImage ? `Faulting image is: ${moduleHint(topImage.name ?? '') ?? 'unclassified'}` : null,
        ].filter(Boolean),
    }];

    const scalar = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));
    const registerLines = (state) => Object.entries(state ?? {}).filter(([name]) => name !== 'flavor').flatMap(([name, value]) => {
        if (Array.isArray(value)) { return value.map((entry, i) => `${`${name}${i}`.padEnd(8)} ${typeof entry?.value === 'number' ? hex(entry.value, 16) : scalar(entry)}`); }
        return [`${name.padEnd(8)} ${typeof value?.value === 'number' ? hex(value.value, 16) : scalar(value)}`];
    });

    threads.forEach((thread, index) => {
        const frames = (thread.frames ?? []).map((frame, i) => frameLine(frame, images, i));
        const details = [thread.id != null ? `thread id ${thread.id}` : null, thread.queue ? `queue ${thread.queue}` : null, thread.threadState?.flavor ? `state ${thread.threadState.flavor}` : null].filter(Boolean).join(', ');
        sections.push({
            title: `Thread ${index}${thread.name ? ` ${thread.name}` : ''}${index === crashedIndex ? ' (crashed)' : ''}${details ? `  [${details}]` : ''}`,
            lines: [...(frames.length ? frames : ['(no frames)']), ...(thread.threadState ? ['registers:', ...registerLines(thread.threadState).map((line) => `  ${line}`)] : [])],
        });
    });

    if (Array.isArray(body.lastExceptionBacktrace) && body.lastExceptionBacktrace.length) {
        sections.push({ title: 'Last exception backtrace', lines: body.lastExceptionBacktrace.map((frame, i) => frameLine(frame, images, i)) });
    }

    sections.push({
        title: `Binary images (${images.length})  [base, size, arch, uuid, path]`,
        lines: images.map((image) => `${hex(image.base ?? 0, 16)}  ${String(image.size ?? 0).padStart(10)}  ${(image.arch ?? '').padEnd(7)}  ${image.uuid ?? ''}  ${image.path ?? image.name ?? '???'}${moduleHint(image.name ?? image.path ?? '') ? `  [${moduleHint(image.name ?? image.path ?? '')}]` : ''}`),
    });

    if (typeof body.vmSummary === 'string') { sections.push({ title: 'VM summary', lines: body.vmSummary.split('\n').filter((line) => line.trim()) }); }

    const listed = new Set(['threads', 'usedImages', 'lastExceptionBacktrace', 'vmSummary', 'exception', 'asi', 'termination', 'bundleInfo', 'osVersion', 'crashReporterKey', 'userID']);
    sections.push({ title: 'All other report fields', lines: [...Object.entries(header).map(([key, value]) => `header.${key}: ${scalar(value)}`), ...Object.entries(body).filter(([key]) => !listed.has(key)).map(([key, value]) => `${key}: ${scalar(value)}`)] });

    return {
        kind: 'Apple crash report (.ips)',
        type: 'apple_crash',
        engine: detection.engine,
        summary: {
            exception: exceptionName,
            detail: exception.subtype ?? asi[0] ?? null,
            location,
            faultHint: topImage ? moduleHint(topImage.name ?? '') : null,
            os,
            engineVersion: detection.version,
            backend: detection.backend,
            process: body.procName ?? header.app_name ?? null,
            notes: detection.notes,
        },
        sections,
        warnings: [],
    };
}

function parseLegacyReport(buffer) {
    const text = decodeText(buffer);
    const field = (name) => text.match(new RegExp(`^${name}:[ \\t]*(.+)$`, 'm'))?.[1]?.trim() ?? null;
    const crashedThread = field('Crashed Thread')?.match(/^\d+/)?.[0] ?? null;
    const block = crashedThread ? text.match(new RegExp(`^Thread ${crashedThread}(?: [^\\n]*)? Crashed:[^\\n]*\\n([\\s\\S]*?)(?:\\n\\s*\\n|$)`, 'm'))?.[1] : null;
    const frames = block ? block.split('\n').map((line) => line.trimEnd()).filter(Boolean) : [];
    const process = field('Process');
    const exception = field('Exception Type') ?? 'unknown';
    const engine = /UnityPlayer|UnityFramework|libunity/.test(text) ? 'Unity' : /UE4Editor|UnrealEditor|\/Engine\/Binaries\/|libUE4|libUnrealEditor/.test(text) ? 'Unreal Engine' : null;
    const location = frames[0]?.replace(/^\d+\s+/, '').replace(/\s+0x[0-9a-f]+\s+/i, ' ') ?? null;

    return {
        kind: 'Apple crash report (text)',
        type: 'apple_crash',
        engine,
        summary: {
            exception,
            detail: field('Exception Codes') ?? field('Exception Subtype'),
            location,
            faultHint: null,
            os: field('OS Version'),
            engineVersion: null,
            backend: null,
            process,
            notes: [],
        },
        sections: [{
            title: 'Report',
            lines: [
                'Type: Apple crash report (text)',
                ...['Process', 'Version', 'Code Type', 'OS Version', 'Date/Time', 'Exception Type', 'Exception Codes', 'Exception Subtype', 'Termination Reason', 'Crashed Thread', 'Application Specific Information'].map((name) => (field(name) ? `${name}: ${field(name)}` : null)).filter(Boolean),
            ],
        }, {
            title: `Crashed thread ${crashedThread ?? '?'}`,
            lines: frames.length ? frames : ['(frames not found)'],
        }, {
            title: 'Full report text',
            lines: text.split(/\r?\n/).map((line) => line.trimEnd()),
        }],
        warnings: [],
    };
}

module.exports = { isIps, isLegacyReport, parseIps, parseLegacyReport };
