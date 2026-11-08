const { Reader, decodeText } = require('./reader');

const BUNDLE_MARKER = 'CR1';
const BUNDLE_MAX_FILES = 256;
const DOTNET_EPOCH_TICKS = 621355968000000000n;
const TICKS_PER_MILLISECOND = 10000n;

const REDACTED_PROPERTIES = new Set(['UserName', 'MachineId', 'LoginId', 'EpicAccountId']);

const PROPERTY_LABELS = [
    ['CrashType', 'Crash type'],
    ['ErrorMessage', 'Error message'],
    ['EngineVersion', 'Engine version'],
    ['BuildVersion', 'Build version'],
    ['BuildConfiguration', 'Build configuration'],
    ['EngineMode', 'Engine mode'],
    ['GameName', 'Game name'],
    ['ExecutableName', 'Executable'],
    ['PlatformFullName', 'Platform'],
    ['PlatformName', 'Platform name'],
    ['CrashGUID', 'Crash GUID'],
    ['TimeOfCrash', 'Time of crash'],
    ['SecondsSinceStart', 'Seconds since start'],
    ['GameStateName', 'Game state'],
    ['UserActivityHint', 'User activity'],
    ['Misc.OSVersionMajor', 'OS'],
    ['Misc.OSVersionMinor', 'OS details'],
    ['Misc.CPUBrand', 'CPU'],
    ['Misc.NumberOfCoresIncludingHyperthreads', 'CPU threads'],
    ['Misc.PrimaryGPUBrand', 'GPU'],
    ['Misc.AnticheatProvider', 'Anti-cheat'],
    ['MemoryStats.TotalPhysicalGB', 'RAM (GB)'],
    ['MemoryStats.UsedPhysical', 'RAM used (bytes)'],
    ['MemoryStats.AvailablePhysical', 'RAM available (bytes)'],
    ['MemoryStats.bIsOOM', 'Out of memory'],
    ['MemoryStats.OOMAllocationSize', 'Failed allocation size'],
    ['CommandLine', 'Command line'],
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const unescapeXml = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') { return String.fromCodePoint(entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)); }
    return ENTITIES[entity.toLowerCase()] ?? match;
});

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function section(xml, name) {
    const match = xml.match(new RegExp(`<${escapeRegex(name)}>([\\s\\S]*?)</${escapeRegex(name)}>`));
    return match ? match[1] : null;
}

function flatProperties(xml) {
    const properties = new Map();
    for (const match of xml.matchAll(/<([A-Za-z0-9_.]+)\s*\/>|<([A-Za-z0-9_.]+)>([^<]*)<\/\2>/g)) {
        const name = match[1] ?? match[2];
        if (!properties.has(name)) { properties.set(name, unescapeXml(match[3] ?? '').trim()); }
    }
    return properties;
}

const stackLines = (text) => (text ? unescapeXml(text).split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim()) : []);

function redactCommandLine(commandLine) {
    return commandLine.replace(/(-(?:AUTH_PASSWORD|AUTH_LOGIN|AUTH_TYPE|epicusername|epicuserid|epicsandboxid|epicdeploymentid|epicportal|token|ticket)=)("[^"]*"|\S+)/gi, '$1<redacted>');
}

function engineGeneration(version) {
    const major = Number(version?.match(/^(\d+)\./)?.[1]);
    return major === 4 ? 'Unreal Engine 4' : major === 5 ? 'Unreal Engine 5' : major ? `Unreal Engine ${major}` : 'Unreal Engine';
}

function parseCrashContext(buffer) {
    const xml = decodeText(buffer).replace(/^\s*<\?xml[^>]*\?>/, '');
    if (!xml.includes('<FGenericCrashContext')) { throw new Error('not an Unreal crash context (missing <FGenericCrashContext>)'); }

    const runtime = section(xml, 'RuntimeProperties') ?? xml;
    const properties = flatProperties(runtime.replace(/<Threads>[\s\S]*?<\/Threads>/, '').replace(/<GPUBreadcrumbs>[\s\S]*?<\/GPUBreadcrumbs>/, ''));
    const platform = flatProperties(section(xml, 'PlatformProperties') ?? '');
    const value = (name) => {
        const raw = properties.get(name);
        if (raw === undefined || raw === '') { return null; }
        if (name === 'CommandLine') { return redactCommandLine(raw); }
        if (name === 'TimeOfCrash' && /^\d{17,19}$/.test(raw)) {
            const date = new Date(Number((BigInt(raw) - DOTNET_EPOCH_TICKS) / TICKS_PER_MILLISECOND));
            return Number.isNaN(date.getTime()) ? raw : date.toISOString();
        }
        return raw;
    };

    const engineVersion = value('EngineVersion');
    const generation = engineGeneration(engineVersion);
    const crashType = value('CrashType') ?? (value('IsAssert') === 'true' ? 'Assert' : value('IsEnsure') === 'true' ? 'Ensure' : null);
    const errorMessage = value('ErrorMessage');

    const sections = [];
    sections.push({
        title: 'Crash context',
        lines: [
            `Engine: ${generation}`,
            ...PROPERTY_LABELS.map(([name, label]) => (value(name) ? `${label}: ${value(name)}` : null)).filter(Boolean),
            ...[...REDACTED_PROPERTIES].filter((name) => value(name)).map((name) => `${name}: <redacted>`),
        ],
    });

    const shown = new Set([...PROPERTY_LABELS.map(([name]) => name), ...REDACTED_PROPERTIES, 'CallStack', 'PCallStack']);
    const otherProperties = [...properties].filter(([name, raw]) => !shown.has(name) && raw !== '').flatMap(([name]) => {
        const text = value(name);
        return text.includes('\n') ? [`${name}:`, ...stackLines(text).map((line) => `    ${line.trim()}`)] : [`${name}: ${text}`];
    });
    if (otherProperties.length) { sections.push({ title: `All other crash properties (${otherProperties.length})`, lines: otherProperties }); }

    const callStack = stackLines(properties.get('CallStack'));
    if (callStack.length) { sections.push({ title: 'Call stack (as written by the engine)', lines: callStack }); }

    const portable = stackLines(section(runtime, 'PCallStack'));
    if (portable.length && !portable.every((line) => /0x0*ffffffff \+ ffffffff/i.test(line))) {
        sections.push({ title: 'Portable call stack (module, base + offset; symbolize with the matching PDB)', lines: portable });
    }

    const threadsXml = section(runtime, 'Threads');
    const threads = threadsXml ? [...threadsXml.matchAll(/<Thread>([\s\S]*?)<\/Thread>/g)].map((match) => flatProperties(match[1])) : [];
    for (const thread of threads.filter((t) => t.get('IsCrashed') === 'true').concat(threads.filter((t) => t.get('IsCrashed') !== 'true'))) {
        const lines = stackLines(thread.get('CallStack'));
        sections.push({ title: `Thread ${thread.get('ThreadID') ?? '?'} ${thread.get('ThreadName') ?? ''}${thread.get('IsCrashed') === 'true' ? ' (crashed)' : ''}`.trim(), lines: lines.length ? lines : ['(no frames)'] });
    }

    const plugins = [...(section(xml, 'EnabledPlugins') ?? '').matchAll(/<Plugin>([\s\S]*?)<\/Plugin>/g)].map((match) => {
        try {
            const plugin = JSON.parse(unescapeXml(match[1]));
            return `${plugin.FriendlyName ?? plugin.Name ?? 'unknown'}${plugin.VersionName ? ` ${plugin.VersionName}` : ''}`;
        } catch {
            return unescapeXml(match[1]).slice(0, 120);
        }
    });
    if (plugins.length) { sections.push({ title: `Enabled plugins (${plugins.length})`, lines: plugins }); }

    const breadcrumbs = section(runtime, 'GPUBreadcrumbs');
    if (breadcrumbs) { sections.push({ title: 'GPU breadcrumbs', lines: stackLines(breadcrumbs.replace(/<(\/?)([A-Za-z0-9_.]+)\s*\/?>/g, (match, closing, name) => (closing ? '\n' : `\n${name}: `))) }); }

    const platformLines = [...platform].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    if (platformLines.length) { sections.push({ title: 'Platform properties', lines: platformLines }); }

    const firstFrame = callStack.find((line) => !/FDebug::|FOutputDevice|AssertFailed|EnsureFailed|ReportAssert|ReportEnsure|FGenericPlatformMisc::RaiseException|RaiseException|KERNELBASE/i.test(line)) ?? callStack[0] ?? null;

    return {
        kind: 'Unreal crash context (CrashContext.runtime-xml)',
        type: 'crash_context',
        engine: 'Unreal Engine',
        userName: properties.get('UserName') || null,
        summary: {
            exception: crashType ? `${crashType}${errorMessage ? `: ${errorMessage}` : ''}` : errorMessage ?? 'no error message',
            detail: null,
            location: firstFrame,
            faultHint: null,
            os: [value('Misc.OSVersionMajor'), value('Misc.OSVersionMinor')].filter(Boolean).join(' ') || value('PlatformFullName'),
            engineVersion: engineVersion ? `${generation} (${engineVersion})` : generation,
            backend: null,
            process: value('ExecutableName') ?? value('GameName'),
            gpu: value('Misc.PrimaryGPUBrand'),
            notes: [],
        },
        sections,
        warnings: [],
    };
}

function readBundleString(reader, offset) {
    const length = reader.i32(offset);
    if (length < 0 || length > 4096) { throw new RangeError(`bad string length ${length}`); }
    return { value: reader.bytes(offset + 4, length).toString('latin1').replace(/\0[\s\S]*$/, ''), end: offset + 4 + length };
}

function unpackBundle(buffer) {
    const reader = new Reader(buffer);
    let offset = buffer.subarray(0, 3).toString('latin1') === BUNDLE_MARKER ? 3 : 0;
    const directory = readBundleString(reader, offset);
    const file = readBundleString(reader, directory.end);
    offset = file.end + 8;

    const files = [];
    for (let index = 0; files.length < BUNDLE_MAX_FILES && offset + 12 <= buffer.length; index++) {
        if (reader.i32(offset) !== index) { break; }
        let name;
        try {
            name = readBundleString(reader, offset + 4);
        } catch {
            break;
        }
        const length = reader.i32(name.end);
        if (!name.value || length < 0 || name.end + 4 + length > buffer.length) { break; }
        files.push({ name: name.value, data: buffer.subarray(name.end + 4, name.end + 4 + length) });
        offset = name.end + 4 + length;
    }
    if (!files.length) { throw new Error('the Unreal crash bundle contains no readable files'); }
    return { directory: directory.value || file.value.replace(/\.ue\d?crash$/i, '') || null, files };
}

module.exports = { parseCrashContext, unpackBundle };
