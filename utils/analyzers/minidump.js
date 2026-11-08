const { Reader, hex, formatBytes, basename } = require('./reader');
const { moduleHint, detectFromModules, formatVersion } = require('./engines');
const { parseCrashContext } = require('./unreal');

const SIGNATURE = 0x504d444d;

const STREAM = {
    THREAD_LIST: 3,
    MODULE_LIST: 4,
    MEMORY_LIST: 5,
    EXCEPTION: 6,
    SYSTEM_INFO: 7,
    MEMORY64_LIST: 9,
    COMMENT_A: 10,
    COMMENT_W: 11,
    UNLOADED_MODULE_LIST: 14,
    MISC_INFO: 15,
    MEMORY_INFO_LIST: 16,
    THREAD_INFO_LIST: 17,
    SYSTEM_MEMORY_INFO: 21,
    PROCESS_VM_COUNTERS: 22,
    THREAD_NAMES: 24,
    WINE_UNIX_MODULES: 0xfff0,
    BREAKPAD_INFO: 0x47670001,
    LINUX_CPU_INFO: 0x47670003,
    LINUX_PROC_STATUS: 0x47670004,
    LINUX_LSB_RELEASE: 0x47670005,
    LINUX_ENVIRON: 0x47670007,
    LINUX_MAPS: 0x47670009,
    HANDLE_DATA: 12,
    CRASHPAD_INFO: 0x43500001,
};

const STREAM_NAMES = {
    3: 'ThreadList', 4: 'ModuleList', 5: 'MemoryList', 6: 'Exception', 7: 'SystemInfo', 8: 'ThreadExList', 9: 'Memory64List',
    10: 'CommentA', 11: 'CommentW', 12: 'HandleData', 13: 'FunctionTable', 14: 'UnloadedModuleList', 15: 'MiscInfo',
    16: 'MemoryInfoList', 17: 'ThreadInfoList', 18: 'HandleOperationList', 19: 'Token', 20: 'JavaScriptData',
    21: 'SystemMemoryInfo', 22: 'ProcessVmCounters', 23: 'IptTrace', 24: 'ThreadNames',
    0xfff0: 'Wine Unix module list',
    0x47670001: 'Breakpad info', 0x47670002: 'Breakpad assertion info', 0x47670003: 'Linux /proc/cpuinfo', 0x47670004: 'Linux /proc/status',
    0x47670005: 'Linux lsb-release', 0x47670006: 'Linux cmdline (not shown)', 0x47670007: 'Linux environ', 0x47670008: 'Linux auxv',
    0x47670009: 'Linux maps', 0x4767000a: 'Linux DSO debug', 0x43500001: 'Crashpad info',
};

const DUMP_FLAGS = [
    [0x1, 'WithDataSegs'], [0x2, 'WithFullMemory'], [0x4, 'WithHandleData'], [0x8, 'FilterMemory'], [0x10, 'ScanMemory'],
    [0x20, 'WithUnloadedModules'], [0x40, 'WithIndirectlyReferencedMemory'], [0x80, 'FilterModulePaths'], [0x100, 'WithProcessThreadData'],
    [0x200, 'WithPrivateReadWriteMemory'], [0x400, 'WithoutOptionalData'], [0x800, 'WithFullMemoryInfo'], [0x1000, 'WithThreadInfo'],
    [0x2000, 'WithCodeSegs'], [0x4000, 'WithoutAuxiliaryState'], [0x8000, 'WithFullAuxiliaryState'], [0x10000, 'WithPrivateWriteCopyMemory'],
    [0x20000, 'IgnoreInaccessibleMemory'], [0x40000, 'WithTokenInformation'], [0x80000, 'WithModuleHeaders'], [0x100000, 'FilterTriage'],
    [0x200000, 'WithAvxXStateContext'], [0x400000, 'WithIptTrace'],
];

const ARCH = { X86: 0, ARM: 5, AMD64: 9, ARM64: 12, BREAKPAD_ARM64: 0x8003 };
const ARCH_NAMES = { [ARCH.X86]: 'x86', [ARCH.ARM]: 'ARM', [ARCH.AMD64]: 'x86-64', [ARCH.ARM64]: 'ARM64', [ARCH.BREAKPAD_ARM64]: 'ARM64' };

const PLATFORM = { WINDOWS_NT: 2, MACOS: 0x8101, IOS: 0x8102, LINUX: 0x8201, SOLARIS: 0x8202, ANDROID: 0x8203, FUCHSIA: 0x8206 };
const PLATFORM_NAMES = { [PLATFORM.MACOS]: 'macOS', [PLATFORM.IOS]: 'iOS', [PLATFORM.LINUX]: 'Linux', [PLATFORM.SOLARIS]: 'Solaris', [PLATFORM.ANDROID]: 'Android', [PLATFORM.FUCHSIA]: 'Fuchsia' };
const PRODUCT_TYPES = { 1: 'workstation', 2: 'domain controller', 3: 'server' };

const EXCEPTION_ACCESS_VIOLATION = 0xc0000005;
const EXCEPTION_IN_PAGE_ERROR = 0xc0000006;
const EXCEPTION_STACK_BUFFER_OVERRUN = 0xc0000409;
const EXCEPTION_MSVC_CPP = 0xe06d7363;
const EXCEPTION_NONCONTINUABLE = 1;
const CRASHPAD_SIMULATED_EXCEPTION = 0x43507378;

const WINDOWS_EXCEPTIONS = {
    [EXCEPTION_ACCESS_VIOLATION]: 'EXCEPTION_ACCESS_VIOLATION',
    [EXCEPTION_IN_PAGE_ERROR]: 'EXCEPTION_IN_PAGE_ERROR',
    0xc0000008: 'STATUS_INVALID_HANDLE',
    0xc000000d: 'STATUS_INVALID_PARAMETER (CRT invalid parameter handler)',
    0xc0000017: 'STATUS_NO_MEMORY',
    0xc000001d: 'EXCEPTION_ILLEGAL_INSTRUCTION',
    0xc0000025: 'EXCEPTION_NONCONTINUABLE_EXCEPTION',
    0xc000008c: 'EXCEPTION_ARRAY_BOUNDS_EXCEEDED',
    0xc000008e: 'EXCEPTION_FLT_DIVIDE_BY_ZERO',
    0xc0000094: 'EXCEPTION_INT_DIVIDE_BY_ZERO',
    0xc0000095: 'EXCEPTION_INT_OVERFLOW',
    0xc0000096: 'EXCEPTION_PRIV_INSTRUCTION',
    0xc00000fd: 'EXCEPTION_STACK_OVERFLOW',
    0xc0000374: 'STATUS_HEAP_CORRUPTION',
    [EXCEPTION_STACK_BUFFER_OVERRUN]: 'STATUS_STACK_BUFFER_OVERRUN (fast fail)',
    0xc0000420: 'STATUS_ASSERTION_FAILURE',
    0xc0000602: 'STATUS_FAIL_FAST_EXCEPTION',
    0x80000003: 'EXCEPTION_BREAKPOINT',
    0x80000004: 'EXCEPTION_SINGLE_STEP',
    [EXCEPTION_MSVC_CPP]: 'C++ exception (MSVC throw)',
    0xe0434352: '.NET CLR exception',
    0x40010005: 'DBG_CONTROL_C',
};

const FAST_FAIL_CODES = ['FAST_FAIL_LEGACY_GS_VIOLATION', 'FAST_FAIL_VTGUARD_CHECK_FAILURE', 'FAST_FAIL_STACK_COOKIE_CHECK_FAILURE', 'FAST_FAIL_CORRUPT_LIST_ENTRY', 'FAST_FAIL_INCORRECT_STACK', 'FAST_FAIL_INVALID_ARG', 'FAST_FAIL_GS_COOKIE_INIT', 'FAST_FAIL_FATAL_APP_EXIT (abort)', 'FAST_FAIL_RANGE_CHECK_FAILURE', 'FAST_FAIL_UNSAFE_REGISTRY_ACCESS'];

const POSIX_SIGNALS = { 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 11: 'SIGSEGV' };
const MAC_EXCEPTIONS = { 1: 'EXC_BAD_ACCESS', 2: 'EXC_BAD_INSTRUCTION', 3: 'EXC_ARITHMETIC', 5: 'EXC_SOFTWARE', 6: 'EXC_BREAKPOINT', 10: 'EXC_CRASH', 11: 'EXC_RESOURCE', 12: 'EXC_GUARD' };
const ACCESS_KINDS = { 0: 'read from', 1: 'write to', 8: 'execute (DEP) at' };

const MEMORY_STATES = { 0x1000: 'committed', 0x2000: 'reserved', 0x10000: 'free' };
const MEMORY_TYPES = { 0x20000: 'private', 0x40000: 'mapped', 0x1000000: 'image' };
const PAGE_PROTECTIONS = { 0x1: 'no access', 0x2: 'read-only', 0x4: 'read/write', 0x8: 'write-copy', 0x10: 'execute', 0x20: 'execute/read', 0x40: 'execute/read/write', 0x80: 'execute/write-copy' };
const PAGE_GUARD = 0x100;

const INTEGRITY_LEVELS = { 0x0: 'untrusted', 0x1000: 'low', 0x2000: 'medium', 0x2100: 'medium plus', 0x3000: 'high', 0x4000: 'system', 0x5000: 'protected process' };

const MISC_FLAG = { PROCESS_ID: 0x1, PROCESS_TIMES: 0x2, POWER_INFO: 0x4, INTEGRITY: 0x10, EXECUTE_FLAGS: 0x20, TIMEZONE: 0x40, PROTECTED: 0x80, BUILD_STRING: 0x100 };

const CONTEXT_LAYOUTS = {
    [ARCH.AMD64]: {
        pointer: 8,
        pc: 'rip',
        sp: 'rsp',
        flags: ['eflags', 0x44, 4],
        registers: [['rax', 0x78], ['rbx', 0x90], ['rcx', 0x80], ['rdx', 0x88], ['rsi', 0xa8], ['rdi', 0xb0], ['rbp', 0xa0], ['rsp', 0x98], ['r8', 0xb8], ['r9', 0xc0], ['r10', 0xc8], ['r11', 0xd0], ['r12', 0xd8], ['r13', 0xe0], ['r14', 0xe8], ['r15', 0xf0], ['rip', 0xf8]],
    },
    [ARCH.X86]: {
        pointer: 4,
        pc: 'eip',
        sp: 'esp',
        flags: ['eflags', 0xc0, 4],
        registers: [['eax', 0xb0], ['ebx', 0xa4], ['ecx', 0xac], ['edx', 0xa8], ['esi', 0xa0], ['edi', 0x9c], ['ebp', 0xb4], ['esp', 0xc4], ['eip', 0xb8]],
    },
    [ARCH.ARM64]: {
        pointer: 8,
        pc: 'pc',
        sp: 'sp',
        flags: ['cpsr', 0x04, 4],
        registers: [...Array.from({ length: 29 }, (_, i) => [`x${i}`, 0x08 + i * 8]), ['fp', 0xf0], ['lr', 0xf8], ['sp', 0x100], ['pc', 0x108]],
    },
};
CONTEXT_LAYOUTS[ARCH.BREAKPAD_ARM64] = CONTEXT_LAYOUTS[ARCH.ARM64];

const MODULE_HEADER_SIZE = 0x1000n;
const CODE_BYTES_BEFORE = 64n;
const CODE_BYTES_LENGTH = 192;
const MAX_LIST_ENTRIES = 65536;
const MAX_ENVIRONMENT_BYTES = 1 << 20;
const IDENTITY_VARIABLE = /^(USER|USERNAME|LOGNAME|COMPUTERNAME|HOSTNAME|HOST|USERDOMAIN|USERDOMAIN_ROAMINGPROFILE|USERDNSDOMAIN|LOGONSERVER|CLIENTNAME|MAIL|EMAIL|SteamUser|SteamAppUser|STEAM_USER)$/i;
const SECRET_VARIABLE =/TOKEN|SECRET|PASSW|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|AUTH|COOKIE|SESSION|CREDENTIAL|BEARER|WEBHOOK/i;

const PROCESS_PARAMETERS = {
    8: { peb: 0x60n, parameters: 0x20n, environment: 0x80n, environmentSize: 0x3f0n },
    4: { peb: 0x30n, parameters: 0x10n, environment: 0x48n, environmentSize: 0x290n },
};

const EXTRA_REGISTERS = {
    [ARCH.AMD64]: {
        minimum: 0x100,
        values: [['ContextFlags', 0x30, 4], ['MxCsr', 0x34, 4], ['SegCs', 0x38, 2], ['SegDs', 0x3a, 2], ['SegEs', 0x3c, 2], ['SegFs', 0x3e, 2], ['SegGs', 0x40, 2], ['SegSs', 0x42, 2], ['Dr0', 0x48, 8], ['Dr1', 0x50, 8], ['Dr2', 0x58, 8], ['Dr3', 0x60, 8], ['Dr6', 0x68, 8], ['Dr7', 0x70, 8]],
        vectors: { offset: 0x1a0, count: 16, name: 'xmm', minimum: 0x2a0 },
    },
    [ARCH.X86]: {
        minimum: 0xcc,
        values: [['ContextFlags', 0x00, 4], ['Dr0', 0x04, 4], ['Dr1', 0x08, 4], ['Dr2', 0x0c, 4], ['Dr3', 0x10, 4], ['Dr6', 0x14, 4], ['Dr7', 0x18, 4], ['SegGs', 0x8c, 4], ['SegFs', 0x90, 4], ['SegEs', 0x94, 4], ['SegDs', 0x98, 4], ['SegCs', 0xbc, 4], ['SegSs', 0xc8, 4]],
        vectors: { offset: 0x16c, count: 8, name: 'xmm', minimum: 0x1ec },
    },
    [ARCH.ARM64]: {
        minimum: 0x110,
        values: [['ContextFlags', 0x00, 4], ['Fpcr', 0x310, 4], ['Fpsr', 0x314, 4]],
        vectors: { offset: 0x110, count: 32, name: 'v', minimum: 0x310 },
    },
};
const FILETIME_UNIX_EPOCH = 116444736000000000n;
const FILETIME_PER_MILLISECOND = 10000n;
const FILETIME_PER_SECOND = 10000000;

function windowsName(major, minor, build) {
    if (major === 10 && build >= 22000) { return 'Windows 11'; }
    if (major === 10) { return 'Windows 10'; }
    if (major === 6 && minor === 3) { return 'Windows 8.1'; }
    if (major === 6 && minor === 2) { return 'Windows 8'; }
    if (major === 6 && minor === 1) { return 'Windows 7'; }
    return `Windows NT ${major}.${minor}`;
}

const readString = (reader, rva) => reader.bytes(rva + 4, Math.min(reader.u32(rva), 0x8000)).toString('utf16le');
const readFixedString = (reader, offset, chars) => reader.bytes(offset, chars * 2).toString('utf16le').replace(/\0[\s\S]*$/, '');
const unixDate = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : 'unknown');

function fileTime(value) {
    if (!value) { return null; }
    const date = new Date(Number((value - FILETIME_UNIX_EPOCH) / FILETIME_PER_MILLISECOND));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const describeFlags = (value, table) => table.filter(([bit]) => value & bit).map(([, name]) => name);

function describeProtection(protect) {
    const base = PAGE_PROTECTIONS[protect & 0xff] ?? `protection ${hex(protect)}`;
    return protect & PAGE_GUARD ? `${base} + guard page` : base;
}

function hexdump(base, bytes, marker = null) {
    const lines = [];
    for (let offset = 0; offset < bytes.length; offset += 16) {
        const row = bytes.subarray(offset, offset + 16);
        const address = base + BigInt(offset);
        const hexPart = [...row].map((byte) => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47);
        const ascii = [...row].map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.')).join('');
        const mark = marker != null && marker >= address && marker < address + 16n ? `  <- ${hex(marker)}` : '';
        lines.push(`${hex(address, 16)}  ${hexPart}  |${ascii}|${mark}`);
    }
    return lines;
}

function readVersion(reader, offset) {
    if (reader.u32(offset) !== 0xfeef04bd) { return null; }
    const ms = reader.u32(offset + 8);
    const ls = reader.u32(offset + 12);
    return { major: ms >>> 16, minor: ms & 0xffff, build: ls >>> 16, revision: ls & 0xffff };
}

function readCodeView(reader, size, rva) {
    if (!size || size < 4) { return null; }
    const signature = reader.bytes(rva, 4).toString('latin1');
    if (signature === 'RSDS' && size >= 25) {
        const guid = reader.bytes(rva + 4, 16);
        const age = reader.u32(rva + 20);
        const pdb = reader.bytes(rva + 24, size - 24).toString('utf8').replace(/\0[\s\S]*$/, '');
        const id = [guid.readUInt32LE(0).toString(16).padStart(8, '0'), guid.readUInt16LE(4).toString(16).padStart(4, '0'), guid.readUInt16LE(6).toString(16).padStart(4, '0'), guid.subarray(8).toString('hex')].join('').toUpperCase();
        return { pdb, debugId: `${id}${age.toString(16).toUpperCase()}` };
    }
    if (signature === 'NB10' && size >= 16) { return { pdb: reader.bytes(rva + 16, size - 16).toString('utf8').replace(/\0[\s\S]*$/, ''), debugId: `${reader.u32(rva + 8).toString(16).toUpperCase()}${reader.u32(rva + 12).toString(16).toUpperCase()}` }; }
    if (signature === 'BpEL') { return { pdb: null, debugId: reader.bytes(rva + 4, size - 4).toString('hex') }; }
    return null;
}

function parseModules(reader, stream) {
    const count = Math.min(reader.u32(stream.rva), MAX_LIST_ENTRIES);
    const modules = [];
    for (let i = 0; i < count; i++) {
        const offset = stream.rva + 4 + i * 108;
        let codeView = null;
        try {
            codeView = readCodeView(reader, reader.u32(offset + 76), reader.u32(offset + 80));
        } catch {
            codeView = null;
        }
        modules.push({
            base: reader.u64(offset),
            size: reader.u32(offset + 8),
            timestamp: reader.u32(offset + 16),
            name: readString(reader, reader.u32(offset + 20)),
            version: readVersion(reader, offset + 24),
            codeView,
        });
    }
    return modules;
}

function parseUnloadedModules(reader, stream) {
    const headerSize = reader.u32(stream.rva);
    const entrySize = reader.u32(stream.rva + 4);
    const count = Math.min(reader.u32(stream.rva + 8), MAX_LIST_ENTRIES);
    return Array.from({ length: count }, (_, i) => {
        const offset = stream.rva + headerSize + i * entrySize;
        return { base: reader.u64(offset), size: reader.u32(offset + 8), timestamp: reader.u32(offset + 16), name: readString(reader, reader.u32(offset + 20)) };
    });
}

function parseThreads(reader, stream) {
    const count = Math.min(reader.u32(stream.rva), MAX_LIST_ENTRIES);
    return Array.from({ length: count }, (_, i) => {
        const offset = stream.rva + 4 + i * 48;
        return {
            id: reader.u32(offset),
            suspendCount: reader.u32(offset + 4),
            priorityClass: reader.u32(offset + 8),
            priority: reader.u32(offset + 12),
            teb: reader.u64(offset + 16),
            stack: { start: reader.u64(offset + 24), size: reader.u32(offset + 32), rva: reader.u32(offset + 36) },
            context: { size: reader.u32(offset + 40), rva: reader.u32(offset + 44) },
        };
    });
}

function parseThreadNames(reader, stream) {
    const count = Math.min(reader.u32(stream.rva), MAX_LIST_ENTRIES);
    const names = new Map();
    for (let i = 0; i < count; i++) {
        const offset = stream.rva + 4 + i * 12;
        names.set(reader.u32(offset), readString(reader, Number(reader.u64(offset + 4))));
    }
    return names;
}

function parseThreadInfo(reader, stream) {
    const headerSize = reader.u32(stream.rva);
    const entrySize = reader.u32(stream.rva + 4);
    const count = Math.min(reader.u32(stream.rva + 8), MAX_LIST_ENTRIES);
    const info = new Map();
    for (let i = 0; i < count; i++) {
        const offset = stream.rva + headerSize + i * entrySize;
        info.set(reader.u32(offset), {
            exitStatus: reader.u32(offset + 12),
            createTime: reader.u64(offset + 16),
            kernelTime: reader.u64(offset + 32),
            userTime: reader.u64(offset + 40),
            startAddress: reader.u64(offset + 48),
            affinity: reader.u64(offset + 56),
        });
    }
    return info;
}

function parseMemoryRanges(reader, streams) {
    const ranges = [];
    const list = streams.get(STREAM.MEMORY_LIST);
    if (list) {
        const count = Math.min(reader.u32(list.rva), 1 << 16);
        for (let i = 0; i < count; i++) {
            const offset = list.rva + 4 + i * 16;
            ranges.push({ start: reader.u64(offset), size: reader.u32(offset + 8), rva: reader.u32(offset + 12) });
        }
    }
    const list64 = streams.get(STREAM.MEMORY64_LIST);
    if (list64) {
        const count = Math.min(Number(reader.u64(list64.rva)), 1 << 20);
        let rva = Number(reader.u64(list64.rva + 8));
        for (let i = 0; i < count; i++) {
            const offset = list64.rva + 16 + i * 16;
            const size = Number(reader.u64(offset + 8));
            ranges.push({ start: reader.u64(offset), size, rva });
            rva += size;
        }
    }
    return ranges;
}

function parseMemoryInfo(reader, stream) {
    const headerSize = reader.u32(stream.rva);
    const entrySize = reader.u32(stream.rva + 4);
    const count = Math.min(Number(reader.u64(stream.rva + 8)), 1 << 18);
    return Array.from({ length: count }, (_, i) => {
        const offset = stream.rva + headerSize + i * entrySize;
        return { base: reader.u64(offset), allocationBase: reader.u64(offset + 8), size: reader.u64(offset + 24), state: reader.u32(offset + 32), protect: reader.u32(offset + 36), type: reader.u32(offset + 40) };
    });
}

function parseException(reader, stream) {
    const offset = stream.rva;
    const parameters = Math.min(reader.u32(offset + 32), 15);
    return {
        threadId: reader.u32(offset),
        code: reader.u32(offset + 8),
        flags: reader.u32(offset + 12),
        nested: reader.u64(offset + 16),
        address: reader.u64(offset + 24),
        information: Array.from({ length: parameters }, (_, i) => reader.u64(offset + 40 + i * 8)),
        context: { size: reader.u32(offset + 160), rva: reader.u32(offset + 164) },
    };
}

function parseSystemInfo(reader, stream) {
    const offset = stream.rva;
    const architecture = reader.u16(offset);
    const csdRva = reader.u32(offset + 24);
    let servicePack = '';
    try {
        servicePack = csdRva ? readString(reader, csdRva) : '';
    } catch {
        servicePack = '';
    }
    const system = {
        architecture,
        level: reader.u16(offset + 2),
        revision: reader.u16(offset + 4),
        processors: reader.u8(offset + 6),
        productType: reader.u8(offset + 7),
        major: reader.u32(offset + 8),
        minor: reader.u32(offset + 12),
        build: reader.u32(offset + 16),
        platform: reader.u32(offset + 20),
        servicePack,
        cpu: null,
    };
    const vendor = (architecture === ARCH.X86 || architecture === ARCH.AMD64) && stream.size >= 56 ? reader.bytes(offset + 32, 12).toString('latin1') : '';
    if (/^[A-Za-z][ -~]{11}$/.test(vendor)) {
        const signature = reader.u32(offset + 44);
        let family = (signature >>> 8) & 0xf;
        let model = (signature >>> 4) & 0xf;
        if (family === 0xf) { family += (signature >>> 20) & 0xff; }
        if (family === 0x6 || family >= 0xf) { model += ((signature >>> 16) & 0xf) << 4; }
        system.cpu = { vendor: vendor.trim(), family, model, stepping: signature & 0xf };
    } else if (architecture === ARCH.X86 || architecture === ARCH.AMD64) {
        system.cpu = { vendor: null, family: system.level, model: system.revision >>> 8, stepping: system.revision & 0xff };
    }
    return system;
}

function parseMiscInfo(reader, stream) {
    const offset = stream.rva;
    const size = reader.u32(offset);
    const flags = reader.u32(offset + 4);
    const has = (flag, minimum) => Boolean(flags & flag) && size >= minimum;
    return {
        processId: has(MISC_FLAG.PROCESS_ID, 24) ? reader.u32(offset + 8) : null,
        createTime: has(MISC_FLAG.PROCESS_TIMES, 24) ? reader.u32(offset + 12) : null,
        userTime: has(MISC_FLAG.PROCESS_TIMES, 24) ? reader.u32(offset + 16) : null,
        kernelTime: has(MISC_FLAG.PROCESS_TIMES, 24) ? reader.u32(offset + 20) : null,
        maxMhz: has(MISC_FLAG.POWER_INFO, 44) ? reader.u32(offset + 24) : null,
        currentMhz: has(MISC_FLAG.POWER_INFO, 44) ? reader.u32(offset + 28) : null,
        mhzLimit: has(MISC_FLAG.POWER_INFO, 44) ? reader.u32(offset + 32) : null,
        integrity: has(MISC_FLAG.INTEGRITY, 232) ? reader.u32(offset + 44) : null,
        executeFlags: has(MISC_FLAG.EXECUTE_FLAGS, 232) ? reader.u32(offset + 48) : null,
        protectedProcess: has(MISC_FLAG.PROTECTED, 232) ? reader.u32(offset + 52) : null,
        timeZoneBias: has(MISC_FLAG.TIMEZONE, 232) ? reader.i32(offset + 60) : null,
        buildString: has(MISC_FLAG.BUILD_STRING, 832) ? readFixedString(reader, offset + 232, 260) : null,
        debugBuildString: has(MISC_FLAG.BUILD_STRING, 832) ? readFixedString(reader, offset + 752, 40) : null,
    };
}

function parseSystemMemory(reader, stream) {
    const offset = stream.rva;
    const pageSize = BigInt(reader.u32(offset + 8));
    return {
        pageSize,
        physical: BigInt(reader.u32(offset + 12)) * pageSize,
        processors: reader.u32(offset + 52),
        fileCache: reader.u64(offset + 56),
        available: reader.u64(offset + 116) * pageSize,
        committed: reader.u64(offset + 124) * pageSize,
        commitLimit: reader.u64(offset + 132) * pageSize,
        peakCommit: reader.u64(offset + 140) * pageSize,
    };
}

function parseVmCounters(reader, stream) {
    const offset = stream.rva;
    const revision = reader.u16(offset);
    const flags = reader.u16(offset + 2);
    return {
        pageFaults: reader.u32(offset + 4),
        peakWorkingSet: reader.u64(offset + 8),
        workingSet: reader.u64(offset + 16),
        pagefile: reader.u64(offset + 56),
        peakPagefile: reader.u64(offset + 64),
        peakVirtual: revision >= 2 && flags & 0x1 ? reader.u64(offset + 72) : null,
        virtual: revision >= 2 && flags & 0x1 ? reader.u64(offset + 80) : null,
        private: revision >= 2 && flags & 0x2 ? reader.u64(offset + 88) : reader.u64(offset + 72),
        privateWorkingSet: revision >= 2 && flags & 0x4 ? reader.u64(offset + 96) : null,
        sharedCommit: revision >= 2 && flags & 0x4 ? reader.u64(offset + 104) : null,
    };
}

function parseText(reader, stream, limit = 65536) {
    return reader.bytes(stream.rva, Math.min(stream.size, limit)).toString('utf8');
}

function readRegisters(reader, layout, context) {
    if (!layout || !context?.size || !context.rva) { return null; }
    const end = Math.max(...layout.registers.map(([, offset]) => offset)) + layout.pointer;
    if (context.size < end) { return null; }
    const read = layout.pointer === 8 ? (offset) => reader.u64(context.rva + offset) : (offset) => BigInt(reader.u32(context.rva + offset));
    const values = new Map(layout.registers.map(([name, offset]) => [name, read(offset)]));
    const [flagName, flagOffset] = layout.flags;
    return { values, pc: values.get(layout.pc), sp: values.get(layout.sp), flags: [flagName, reader.u32(context.rva + flagOffset)] };
}

function readExtraRegisters(reader, architecture, context) {
    const layout = EXTRA_REGISTERS[architecture];
    if (!layout || !context?.size || context.size < layout.minimum) { return []; }
    const read = { 2: (o) => reader.u16(context.rva + o), 4: (o) => reader.u32(context.rva + o), 8: (o) => reader.u64(context.rva + o) };
    const lines = layout.values.filter(([, offset, size]) => offset + size <= context.size).map(([name, offset, size]) => `${name.padEnd(12)} ${hex(read[size](offset), size * 2)}`);
    const { vectors } = layout;
    if (context.size >= vectors.minimum) {
        for (let i = 0; i < vectors.count; i++) {
            const bytes = reader.bytes(context.rva + vectors.offset + i * 16, 16);
            lines.push(`${`${vectors.name}${i}`.padEnd(12)} 0x${Buffer.from(bytes).reverse().toString('hex')}`);
        }
    }
    return lines;
}

function rangeLookup(items, startOf, sizeOf) {
    const sorted = items.map((item) => ({ item, start: startOf(item), end: startOf(item) + sizeOf(item) })).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    return (address) => {
        let low = 0;
        let high = sorted.length - 1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const entry = sorted[middle];
            if (address < entry.start) { high = middle - 1; }
            else if (address >= entry.end) { low = middle + 1; }
            else { return entry.item; }
        }
        return null;
    };
}

function parseEnvironmentBlock(text) {
    const identities = [];
    const lines = text.split('\0').filter((entry) => entry && !entry.startsWith('=')).map((entry) => {
        const split = entry.indexOf('=');
        const name = split > 0 ? entry.slice(0, split) : entry;
        const value = split > 0 ? entry.slice(split + 1) : '';
        if (IDENTITY_VARIABLE.test(name) && value) { identities.push(value); }
        return (SECRET_VARIABLE.test(name) || IDENTITY_VARIABLE.test(name)) && value ? `${name}=<redacted>` : `${name}=${value}`;
    });
    return { lines, identities };
}

function describeOs(system, lsbRelease, misc) {
    if (!system) { return 'unknown'; }
    const arch = ARCH_NAMES[system.architecture] ?? `architecture ${system.architecture}`;
    if (system.platform === PLATFORM.WINDOWS_NT) {
        const build = misc?.buildString ? `, ${misc.buildString}` : '';
        return `${windowsName(system.major, system.minor, system.build)} (build ${system.major}.${system.minor}.${system.build}${system.servicePack ? `, ${system.servicePack}` : ''}${build}), ${arch}`;
    }
    const name = PLATFORM_NAMES[system.platform] ?? `platform ${hex(system.platform)}`;
    const version = system.major || system.minor || system.build ? ` ${system.major}.${system.minor}.${system.build}` : '';
    const details = [lsbRelease, system.servicePack].filter(Boolean).join('; ');
    return `${name}${version}${details ? ` (${details})` : ''}, ${arch}`;
}

function exceptionName(exception, platform) {
    if (exception.code === CRASHPAD_SIMULATED_EXCEPTION) { return 'Crashpad simulated exception (the app requested a dump; not a hardware fault)'; }
    if (platform === PLATFORM.LINUX || platform === PLATFORM.ANDROID || platform === PLATFORM.SOLARIS) { return `${POSIX_SIGNALS[exception.code] ?? `signal ${exception.code}`} (si_code ${exception.flags})`; }
    if (platform === PLATFORM.MACOS || platform === PLATFORM.IOS) { return `${MAC_EXCEPTIONS[exception.code] ?? `Mach exception ${exception.code}`} (code ${hex(exception.flags)})`; }
    return `${WINDOWS_EXCEPTIONS[exception.code] ?? 'unknown exception'} (${hex(exception.code, 8)})`;
}

function scanStack(reader, thread, sp, pointer, findModule, limit) {
    if (!thread?.stack?.size || sp == null) { return []; }
    const { start, size, rva } = thread.stack;
    const from = sp >= start && sp < start + BigInt(size) ? Number(sp - start) : 0;
    const hits = [];
    for (let offset = from - (from % pointer); offset + pointer <= size && hits.length < limit; offset += pointer) {
        const value = pointer === 8 ? reader.u64(rva + offset) : BigInt(reader.u32(rva + offset));
        const module = findModule(value);
        if (module && value - module.base >= MODULE_HEADER_SIZE) { hits.push({ slot: start + BigInt(offset), value, module }); }
    }
    return hits;
}

function moduleCategory(module) {
    const hint = moduleHint(module.name);
    if (hint) { return hint; }
    if (/[\\/]windows[\\/](system32|syswow64|winsxs)[\\/]/i.test(module.name) || /^\/(usr\/)?lib/.test(module.name)) { return 'system'; }
    return 'game / third party';
}

function findEmbeddedCrashContext(reader, streams) {
    for (const [type, stream] of streams) {
        if (type <= 0xffff || stream.size < 64) { continue; }
        const head = reader.bytes(stream.rva, Math.min(stream.size, 512)).toString('utf16le');
        if (!head.includes('<FGenericCrashContext')) { continue; }
        const text = reader.bytes(stream.rva, stream.size).toString('utf16le').replace(/\0[\s\S]*$/, '');
        return { type, context: parseCrashContext(Buffer.from(text, 'utf8')) };
    }
    return null;
}

function parseMinidump(buffer) {
    const reader = new Reader(buffer);
    if (reader.u32(0) !== SIGNATURE) { throw new Error('not a minidump (missing MDMP signature)'); }

    const version = reader.u32(4);
    const streamCount = Math.min(reader.u32(8), 4096);
    const directory = reader.u32(12);
    const timestamp = reader.u32(20);
    const dumpFlags = Number(reader.u64(24) & 0xffffffffn);
    const streams = new Map();
    for (let i = 0; i < streamCount; i++) {
        const offset = directory + i * 12;
        const type = reader.u32(offset);
        if (type && !streams.has(type)) { streams.set(type, { size: reader.u32(offset + 4), rva: reader.u32(offset + 8) }); }
    }

    const warnings = [];
    const read = (type, parse) => {
        const stream = streams.get(type);
        if (!stream) { return null; }
        try {
            return parse(reader, stream);
        } catch (error) {
            warnings.push(`The ${STREAM_NAMES[type] ?? hex(type)} stream is damaged: ${error.message}`);
            return null;
        }
    };
    const attempt = (label, fn, fallback) => {
        try {
            return fn();
        } catch (error) {
            warnings.push(`${label}: ${error.message}`);
            return fallback;
        }
    };

    const system = read(STREAM.SYSTEM_INFO, parseSystemInfo);
    const misc = read(STREAM.MISC_INFO, parseMiscInfo);
    const modules = read(STREAM.MODULE_LIST, parseModules) ?? [];
    const unixModules = read(STREAM.WINE_UNIX_MODULES, parseModules) ?? [];
    const unloaded = read(STREAM.UNLOADED_MODULE_LIST, parseUnloadedModules) ?? [];
    const threads = read(STREAM.THREAD_LIST, parseThreads) ?? [];
    const threadNames = read(STREAM.THREAD_NAMES, parseThreadNames) ?? new Map();
    const threadInfo = read(STREAM.THREAD_INFO_LIST, parseThreadInfo) ?? new Map();
    const exception = read(STREAM.EXCEPTION, parseException);
    const systemMemory = read(STREAM.SYSTEM_MEMORY_INFO, parseSystemMemory);
    const vm = read(STREAM.PROCESS_VM_COUNTERS, parseVmCounters);
    const memoryInfo = read(STREAM.MEMORY_INFO_LIST, parseMemoryInfo) ?? [];
    const lsbRelease = read(STREAM.LINUX_LSB_RELEASE, (r, s) => parseText(r, s, 4096).match(/^(?:PRETTY_NAME|DISTRIB_DESCRIPTION)="?([^"\n]+)"?/m)?.[1] ?? null);
    const linuxCpu = read(STREAM.LINUX_CPU_INFO, (r, s) => parseText(r, s).match(/^model name\s*:\s*(.+)$/m)?.[1] ?? null);
    const linuxStatus = read(STREAM.LINUX_PROC_STATUS, (r, s) => parseText(r, s).split('\n').filter((line) => /^(Name|State|Threads|VmPeak|VmSize|VmHWM|VmRSS|VmData|VmStk|VmSwap):/.test(line)).map((line) => line.replace(/\s+/g, ' ').trim()));
    const comment = read(STREAM.COMMENT_W, (r, s) => r.bytes(s.rva, Math.min(s.size, 4096)).toString('utf16le').replace(/\0[\s\S]*$/, '')) ?? read(STREAM.COMMENT_A, (r, s) => parseText(r, s, 4096).replace(/\0[\s\S]*$/, ''));
    const ranges = attempt('The captured memory list is damaged', () => parseMemoryRanges(reader, streams), []);
    const embedded = attempt('The embedded Unreal crash context is damaged', () => findEmbeddedCrashContext(reader, streams), null);
    const linuxEnvironment = read(STREAM.LINUX_ENVIRON, (r, s) => parseEnvironmentBlock(r.bytes(s.rva, Math.min(s.size, MAX_ENVIRONMENT_BYTES)).toString('utf8')));
    const linuxMaps = read(STREAM.LINUX_MAPS, (r, s) => parseText(r, s, MAX_ENVIRONMENT_BYTES).split('\n').filter(Boolean));
    const breakpadInfo = read(STREAM.BREAKPAD_INFO, (r, s) => ({ validity: r.u32(s.rva), dumpThread: r.u32(s.rva + 4), requestingThread: r.u32(s.rva + 8) }));
    const handles = read(STREAM.HANDLE_DATA, (r, s) => {
        const headerSize = r.u32(s.rva);
        const descriptorSize = r.u32(s.rva + 4);
        const count = Math.min(r.u32(s.rva + 8), MAX_LIST_ENTRIES);
        const text = (rva) => (rva ? readString(r, rva) : '');
        return Array.from({ length: count }, (_, i) => {
            const offset = s.rva + headerSize + i * descriptorSize;
            return { handle: r.u64(offset), type: text(r.u32(offset + 8)), object: text(r.u32(offset + 12)), access: r.u32(offset + 20), handleCount: r.u32(offset + 24) };
        });
    }) ?? [];

    const findModule = rangeLookup(modules, (module) => module.base, (module) => BigInt(module.size));
    const findUnloaded = (address) => unloaded.find((module) => address >= module.base && address < module.base + BigInt(module.size)) ?? null;
    const findStackOwner = rangeLookup(threads.filter((thread) => thread.stack.size), (thread) => thread.stack.start, (thread) => BigInt(thread.stack.size));
    const findRegion = rangeLookup(memoryInfo, (region) => region.base, (region) => region.size);
    const findRange = rangeLookup(ranges, (range) => range.start, (range) => BigInt(range.size));
    const readMemory = (address, length) => {
        const range = findRange(address);
        if (!range) { return null; }
        const offset = Number(address - range.start);
        return reader.bytes(range.rva + offset, Math.min(length, range.size - offset));
    };
    const where = (address) => {
        const module = findModule(address);
        if (module) { return `${basename(module.name)}+${hex(address - module.base)}`; }
        const owner = findStackOwner(address);
        if (owner) { return `stack of thread ${owner.id}${threadNames.get(owner.id) ? ` (${threadNames.get(owner.id)})` : ''}`; }
        const gone = findUnloaded(address);
        if (gone) { return `inside UNLOADED module ${basename(gone.name)}+${hex(address - gone.base)}`; }
        return null;
    };
    const threadLabel = (id) => `${id}${threadNames.get(id) ? ` (${threadNames.get(id)})` : ''}`;
    const readPointer = (address, size) => {
        const bytes = readMemory(address, size);
        if (!bytes || bytes.length < size) { return null; }
        return size === 8 ? bytes.readBigUInt64LE(0) : BigInt(bytes.readUInt32LE(0));
    };
    const windowsEnvironment = () => {
        const pointer = system?.architecture === ARCH.X86 ? 4 : 8;
        const offsets = PROCESS_PARAMETERS[pointer];
        const teb = threads.find((thread) => thread.teb)?.teb;
        if (!teb) { return null; }
        const peb = readPointer(teb + offsets.peb, pointer);
        const parameters = peb ? readPointer(peb + offsets.parameters, pointer) : null;
        const environment = parameters ? readPointer(parameters + offsets.environment, pointer) : null;
        if (!environment) { return null; }
        const declared = Number(readPointer(parameters + offsets.environmentSize, pointer) ?? 0n);
        const block = readMemory(environment, Math.min(declared > 0 ? declared : MAX_ENVIRONMENT_BYTES, MAX_ENVIRONMENT_BYTES));
        if (!block) { return null; }
        const text = block.toString('utf16le');
        const end = text.indexOf('\0\0');
        return parseEnvironmentBlock(end >= 0 ? text.slice(0, end) : text);
    };
    const environment = linuxEnvironment ?? (system?.platform === PLATFORM.WINDOWS_NT || !system ? attempt('Reading the process environment failed', windowsEnvironment, null) : null);

    const platform = system?.platform ?? PLATFORM.WINDOWS_NT;
    const windows = !system || platform === PLATFORM.WINDOWS_NT;
    const layout = system ? CONTEXT_LAYOUTS[system.architecture] : null;
    const crashedThread = exception ? threads.find((thread) => thread.id === exception.threadId) : null;
    const registers = attempt("The crashing thread's register context is damaged", () => readRegisters(reader, layout, exception?.context?.size ? exception.context : crashedThread?.context), null);
    const instruction = exception ? (windows ? exception.address : registers?.pc ?? exception.address) : null;
    const faultModule = instruction != null ? findModule(instruction) : null;
    const location = instruction != null ? (where(instruction) ?? `${hex(instruction, 16)} (not inside any loaded module: JIT code, a bad jump or freed memory)`) : null;
    const raised = faultModule && windows && basename(faultModule.name).toLowerCase() === 'kernelbase.dll';
    const faultHint = raised ? 'raised in software via RaiseException (a C++ throw, an engine assert, abort or a fatal error handler)' : faultModule ? moduleHint(faultModule.name) : null;
    const detection = detectFromModules(modules, [...threadNames.values()]);
    const kind = system && !windows ? `${PLATFORM_NAMES[platform] ?? 'Breakpad'} minidump` : 'Windows minidump';
    const os = describeOs(system, lsbRelease, misc);
    const uptime = misc?.createTime && timestamp >= misc.createTime ? timestamp - misc.createTime : null;
    const gpuStack = unixModules.map((module) => moduleHint(module.name)).filter((hint) => /driver|Mesa|NVIDIA|Vulkan/.test(hint ?? ''));
    const runnerPath = unixModules.map((module) => module.name).find((name) => /[\\/](runners|compatibilitytools\.d|common)[\\/][^\\/]+[\\/](files|dist)[\\/]lib/i.test(name));
    const runner = runnerPath?.match(/[\\/](?:runners|compatibilitytools\.d|common)[\\/]([^\\/]+)[\\/](?:files|dist)[\\/]lib/i)?.[1] ?? null;
    const container = unixModules.some((module) => /pressure-vessel/.test(module.name)) ? 'Steam Linux Runtime (pressure-vessel container)' : null;
    if (runner) { detection.notes.push(`Wine/Proton runner: ${runner}`); }
    if (container) { detection.notes.push(container); }
    if (!system && !modules.length && !threads.length) { warnings.push('No readable system, module or thread data: the dump is truncated or damaged.'); }

    const sections = [];
    let exceptionDetail = null;

    sections.push({
        title: 'Dump',
        lines: [
            `Type: ${kind}`,
            `Format version: ${hex(version & 0xffff)}${version >>> 16 ? ` (implementation ${hex(version >>> 16)})` : ''}`,
            `Written: ${unixDate(timestamp)}`,
            `Dump flags: ${dumpFlags ? describeFlags(dumpFlags, DUMP_FLAGS).join(', ') : 'MiniDumpNormal'} (${hex(dumpFlags)})`,
            misc?.debugBuildString ? `Written by: ${misc.debugBuildString}` : unixModules.length || detection.notes.length ? 'Written by: Wine dbghelp' : null,
            `Captured memory: ${ranges.length} range(s), ${formatBytes(ranges.reduce((sum, range) => sum + range.size, 0))}`,
            `Streams: ${[...streams].map(([type, stream]) => `${STREAM_NAMES[type] ?? hex(type)} (${formatBytes(stream.size)})`).join(', ')}`,
            comment ? `Comment: ${comment}` : null,
        ].filter(Boolean),
    });

    sections.push({
        title: 'System',
        lines: [
            `OS: ${os}`,
            system?.productType ? `Product type: ${PRODUCT_TYPES[system.productType] ?? system.productType}` : null,
            system ? `CPU: ${system.cpu ? `${system.cpu.vendor ?? 'x86'}${system.cpu.family ? ` family ${system.cpu.family} model ${system.cpu.model} stepping ${system.cpu.stepping}` : ''}` : `level ${system.level} revision ${hex(system.revision)}`}${linuxCpu ? ` (${linuxCpu})` : ''}` : null,
            system ? `Logical processors: ${system.processors}` : null,
            misc?.maxMhz ? `CPU clock: ${misc.currentMhz} MHz (max ${misc.maxMhz} MHz${misc.mhzLimit && misc.mhzLimit !== misc.maxMhz ? `, limited to ${misc.mhzLimit} MHz` : ''})` : null,
            systemMemory ? `RAM: ${formatBytes(systemMemory.physical)} total, ${formatBytes(systemMemory.available)} available at crash` : null,
            systemMemory ? `Commit: ${formatBytes(systemMemory.committed)} of ${formatBytes(systemMemory.commitLimit)} (peak ${formatBytes(systemMemory.peakCommit)})` : null,
            systemMemory ? `File cache: ${formatBytes(systemMemory.fileCache)}` : null,
            misc?.timeZoneBias != null ? `Time zone: UTC${misc.timeZoneBias <= 0 ? '+' : '-'}${Math.abs(misc.timeZoneBias) / 60}` : null,
        ].filter(Boolean),
    });

    sections.push({
        title: 'Process',
        lines: [
            detection.executable ? `Executable: ${modules[0]?.name ?? detection.executable}${detection.game ? ` (${detection.game})` : ''}` : null,
            modules[0]?.version ? `Executable version: ${formatVersion(modules[0].version)}` : null,
            misc?.processId != null ? `Process ID: ${misc.processId}` : null,
            misc?.createTime ? `Started: ${unixDate(misc.createTime)}` : null,
            uptime != null ? `Uptime at crash: ${uptime}s (${(uptime / 60).toFixed(1)} min)` : null,
            misc?.userTime != null ? `CPU time: ${misc.userTime}s user, ${misc.kernelTime}s kernel` : null,
            misc?.integrity != null ? `Integrity level: ${INTEGRITY_LEVELS[misc.integrity] ?? hex(misc.integrity)}` : null,
            misc?.protectedProcess ? 'Protected process: yes' : null,
            misc?.executeFlags != null ? `Execute flags: ${hex(misc.executeFlags)}` : null,
            vm ? `Working set: ${formatBytes(vm.workingSet)} (peak ${formatBytes(vm.peakWorkingSet)})` : null,
            vm ? `Private memory: ${formatBytes(vm.private)}${vm.privateWorkingSet != null ? `, private working set ${formatBytes(vm.privateWorkingSet)}` : ''}` : null,
            vm?.virtual != null ? `Virtual size: ${formatBytes(vm.virtual)} (peak ${formatBytes(vm.peakVirtual)})` : null,
            vm ? `Pagefile usage: ${formatBytes(vm.pagefile)} (peak ${formatBytes(vm.peakPagefile)})` : null,
            vm ? `Page faults: ${vm.pageFaults.toLocaleString('en-US')}` : null,
            ...(linuxStatus ?? []),
            `Threads: ${threads.length}, modules: ${modules.length}${unloaded.length ? `, unloaded modules: ${unloaded.length}` : ''}`,
        ].filter(Boolean),
    });

    sections.push({
        title: 'Engine',
        lines: [
            `Engine: ${embedded ? embedded.context.summary.engineVersion : detection.engine ?? 'not detected from modules'}`,
            !embedded && detection.version ? `Version: ${detection.version}` : null,
            detection.backend ? `Scripting backend: ${detection.backend}` : null,
            detection.game ? `Game: ${detection.game}` : null,
            ...detection.notes,
            gpuStack.length ? `Linux graphics stack (Wine Unix side): ${[...new Set(gpuStack)].join(', ')}` : null,
        ].filter(Boolean),
    });

    if (exception) {
        const info = exception.information;
        const decoded = [];
        if (windows && (exception.code === EXCEPTION_ACCESS_VIOLATION || exception.code === EXCEPTION_IN_PAGE_ERROR) && info.length >= 2) {
            decoded.push(`Tried to ${ACCESS_KINDS[Number(info[0])] ?? `access (type ${info[0]})`} ${hex(info[1], 16)}${info[1] < 0x10000n ? ' (near-null pointer: usually a null object/pointer dereference)' : ''}`);
            if (exception.code === EXCEPTION_IN_PAGE_ERROR && info.length >= 3) { decoded.push(`Underlying I/O status: ${hex(info[2], 8)}`); }
        }
        if (windows && exception.code === EXCEPTION_STACK_BUFFER_OVERRUN && info.length >= 1) { decoded.push(`Fast fail code: ${FAST_FAIL_CODES[Number(info[0])] ?? info[0].toString()}`); }
        if (windows && exception.code === EXCEPTION_MSVC_CPP && info.length >= 3) {
            const thrower = info.length >= 4 ? findModule(info[3]) : findModule(info[2]);
            decoded.push(`Thrown object at ${hex(info[1], 16)}, throw info at ${hex(info[2], 16)}`);
            if (thrower) { decoded.push(`Thrown by module: ${basename(thrower.name)}`); }
        }
        const accessed = windows ? (info.length >= 2 && (exception.code === EXCEPTION_ACCESS_VIOLATION || exception.code === EXCEPTION_IN_PAGE_ERROR) ? info[1] : null) : exception.address;
        if (accessed != null) {
            const region = findRegion(accessed);
            const owner = where(accessed);
            decoded.push(`Accessed address lies in: ${owner ?? 'no module or thread stack'}${readMemory(accessed, 1) ? ' (memory captured in the dump)' : ''}`);
            if (region) { decoded.push(`Accessed address region: ${MEMORY_STATES[region.state] ?? hex(region.state)}, ${describeProtection(region.protect)}, ${MEMORY_TYPES[region.type] ?? 'no type'}, ${hex(region.base, 16)} + ${formatBytes(region.size)}`); }
        }
        if (faultModule) {
            decoded.push(`Faulting module: ${faultModule.name}`);
            decoded.push(`Faulting module is: ${faultHint ?? moduleCategory(faultModule)}`);
            if (faultModule.version) { decoded.push(`Faulting module version: ${formatVersion(faultModule.version)}`); }
            if (faultModule.timestamp) { decoded.push(`Faulting module build date: ${unixDate(faultModule.timestamp)}`); }
            if (faultModule.codeView?.pdb) { decoded.push(`Faulting module symbols: ${faultModule.codeView.pdb} (debug id ${faultModule.codeView.debugId})`); }
        }
        exceptionDetail = decoded[0] ?? null;
        const region = instruction != null ? findRegion(instruction) : null;
        if (region) { decoded.push(`Instruction region: ${MEMORY_STATES[region.state] ?? hex(region.state)}, ${describeProtection(region.protect)}, ${MEMORY_TYPES[region.type] ?? 'no type'}`); }

        sections.push({
            title: 'Exception',
            lines: [
                exceptionName(exception, platform),
                ...decoded,
                `Crashing thread: ${threadLabel(exception.threadId)}`,
                windows ? `Faulting instruction: ${hex(exception.address, 16)}` : `Accessed memory address: ${hex(exception.address, 16)}`,
                windows ? null : `Program counter: ${instruction != null ? hex(instruction, 16) : 'unknown'}`,
                `Location: ${location}`,
                `Exception flags: ${hex(exception.flags)}${windows && exception.flags & EXCEPTION_NONCONTINUABLE ? ' (non-continuable)' : ''}`,
                exception.nested ? `Nested exception record at ${hex(exception.nested, 16)}` : null,
                info.length ? `Parameters: ${info.map((value, i) => `[${i}] ${hex(value, 16)}`).join('  ')}` : 'Parameters: none',
            ].filter(Boolean),
        });
    } else {
        sections.push({ title: 'Exception', lines: ['The dump has no exception record (it may have been written for a hang, a manual dump or a watchdog).'] });
    }

    if (embedded) {
        sections.push({ title: `Unreal crash context embedded in the dump (stream ${hex(embedded.type)})`, lines: [`Error: ${embedded.context.summary.exception}`] });
        sections.push(...embedded.context.sections.map((section) => ({ ...section, title: `[embedded] ${section.title}` })));
    }

    const registerLines = (regs, context, indent = '') => [
        ...[...regs.values].map(([name, value]) => {
            const target = where(value);
            return `${indent}${name.padEnd(12)} ${hex(value, layout.pointer * 2)}${target ? `  -> ${target}` : ''}`;
        }),
        `${indent}${regs.flags[0].padEnd(12)} ${hex(regs.flags[1], 8)}`,
        ...attempt('Reading extended registers failed', () => readExtraRegisters(reader, system.architecture, context), []).map((line) => `${indent}${line}`),
    ];
    const crashContext = exception?.context?.size ? exception.context : crashedThread?.context;

    if (registers) {
        sections.push({ title: 'Crashing thread registers (full context)', lines: registerLines(registers, crashContext) });
    } else if (system && !layout) {
        sections.push({ title: 'Crashing thread registers', lines: [`Register context for ${ARCH_NAMES[system.architecture] ?? 'this CPU'} is not supported.`] });
    }

    if (instruction != null) {
        const start = instruction > CODE_BYTES_BEFORE ? instruction - CODE_BYTES_BEFORE : 0n;
        const code = attempt('Reading code bytes failed', () => readMemory(start, CODE_BYTES_LENGTH) ?? readMemory(instruction, CODE_BYTES_LENGTH - Number(CODE_BYTES_BEFORE)), null);
        const base = code && readMemory(start, 1) ? start : instruction;
        sections.push({ title: 'Code bytes at the crash', lines: code ? hexdump(base, code, instruction) : ['The dump does not contain the memory around the instruction pointer.'] });
    }

    const scanLine = (hit) => `${hex(hit.slot, 16)}  ${hex(hit.value, 16)}  ${basename(hit.module.name)}+${hex(hit.value - hit.module.base)}`;
    const scan = attempt("Scanning the crashing thread's stack failed", () => scanStack(reader, crashedThread, registers?.sp, layout?.pointer ?? 8, findModule, Infinity), []);
    if (scan.length) {
        sections.push({ title: `Crashing thread stack scan (${scan.length} hits; heuristic: every stack value that points into a loaded module, not a symbolized unwind)  [stack slot, value, module+offset]`, lines: scan.map(scanLine) });
    }

    if (registers?.sp != null && crashedThread?.stack?.size) {
        const stackEnd = crashedThread.stack.start + BigInt(crashedThread.stack.size);
        const from = registers.sp >= crashedThread.stack.start && registers.sp < stackEnd ? registers.sp : crashedThread.stack.start;
        const stackBytes = attempt('Reading stack memory failed', () => readMemory(from, Number(stackEnd - from)), null);
        if (stackBytes) { sections.push({ title: `Crashing thread stack memory (${stackBytes.length} bytes, stack pointer to the end of the captured stack)`, lines: hexdump(from, stackBytes, registers.sp) }); }
    }

    const threadLines = [];
    for (const thread of threads) {
        const info = threadInfo.get(thread.id);
        const context = thread.id === exception?.threadId && exception?.context?.size ? exception.context : thread.context;
        const regs = attempt(`Thread ${thread.id} context is damaged`, () => readRegisters(reader, layout, context), null);
        threadLines.push(`Thread ${threadLabel(thread.id)}${thread.id === exception?.threadId ? '  <== CRASHED' : ''}`);
        if (regs) { threadLines.push(`    at ${hex(regs.pc, 16)}  ${where(regs.pc) ?? '(not in a module)'}`); }
        threadLines.push(`    stack ${hex(thread.stack.start, 16)} + ${formatBytes(thread.stack.size)} captured, TEB ${hex(thread.teb, 16)}, suspend count ${thread.suspendCount}, priority ${thread.priority}, priority class ${hex(thread.priorityClass)}`);
        if (info) {
            threadLines.push(`    entry point ${hex(info.startAddress, 16)}  ${where(info.startAddress) ?? '(not in a module)'}`);
            const created = fileTime(info.createTime);
            threadLines.push(`    created ${created ?? 'unknown'}, cpu ${(Number(info.userTime) / FILETIME_PER_SECOND).toFixed(3)}s user / ${(Number(info.kernelTime) / FILETIME_PER_SECOND).toFixed(3)}s kernel, affinity ${hex(info.affinity)}, exit status ${hex(info.exitStatus)}`);
        }
        if (regs) { threadLines.push('    registers:', ...registerLines(regs, context, '      ')); }
        const hits = attempt(`Scanning thread ${thread.id} failed`, () => scanStack(reader, thread, regs?.sp, layout?.pointer ?? 8, findModule, Infinity), []);
        threadLines.push(`    stack scan (${hits.length} hits):`, ...hits.map((hit) => `      ${scanLine(hit)}`));
        threadLines.push('');
    }
    sections.push({ title: `Threads (${threads.length}; stack scans are heuristic)`, lines: threadLines.length ? threadLines : ['(no thread list)'] });

    if (environment) {
        sections.push({ title: `Environment variables (${environment.lines.length}; secret and identity values are redacted)`, lines: environment.lines.length ? environment.lines : ['(empty environment)'] });
    } else {
        sections.push({ title: 'Environment variables', lines: [windows ? 'Not captured: this dump does not include the process environment block (PEB). Only full-memory dumps (MiniDumpWithFullMemory) contain it.' : 'Not captured: this dump has no environment stream.'] });
    }

    const moduleRow = (module) => {
        const parts = [
            `${hex(module.base, 16)}-${hex(module.base + BigInt(module.size), 16)}`,
            formatBytes(module.size).padStart(10),
            module.timestamp ? unixDate(module.timestamp).slice(0, 10) : '          ',
            (module.version ? `v${formatVersion(module.version)}` : '').padEnd(18),
            module.name,
        ];
        const extra = [moduleCategory(module), module.codeView?.pdb ? `pdb ${basename(module.codeView.pdb)}` : null, module.codeView?.debugId ? `id ${module.codeView.debugId}` : null].filter(Boolean);
        return `${parts.join('  ')}${module === faultModule ? '  <== FAULTING MODULE' : ''}\n      ${extra.join(' | ')}`;
    };
    const ordered = [...modules].sort((a, b) => Number(moduleCategory(a) === 'system') - Number(moduleCategory(b) === 'system'));
    sections.push({ title: `Loaded modules (${modules.length}; game and third-party first, then system)  [range, size, build date, version, path]`, lines: ordered.map(moduleRow) });

    if (unixModules.length) {
        sections.push({ title: `Wine Unix-side modules (${unixModules.length})`, lines: unixModules.map((module) => `${hex(module.base, 16)}  ${formatBytes(module.size).padStart(10)}  ${module.name}${moduleHint(module.name) ? `  [${moduleHint(module.name)}]` : ''}`) });
    }
    if (unloaded.length) {
        sections.push({ title: `Unloaded modules (${unloaded.length})`, lines: unloaded.map((module) => `${hex(module.base, 16)}  ${formatBytes(module.size).padStart(10)}  ${module.timestamp ? unixDate(module.timestamp).slice(0, 10) : ''}  ${module.name}`) });
    }
    if (memoryInfo.length) {
        const committed = memoryInfo.filter((region) => region.state === 0x1000);
        const total = (filter) => formatBytes(committed.filter(filter).reduce((sum, region) => sum + region.size, 0n));
        sections.push({
            title: 'Address space summary (from the memory info list)',
            lines: [
                `Regions: ${memoryInfo.length}, committed: ${committed.length}`,
                `Committed image memory: ${total((region) => region.type === 0x1000000)}`,
                `Committed private memory: ${total((region) => region.type === 0x20000)}`,
                `Committed mapped memory: ${total((region) => region.type === 0x40000)}`,
            ],
        });
        sections.push({
            title: `Address space regions (${memoryInfo.length})  [base, size, state, protection, type, owner]`,
            lines: memoryInfo.map((region) => `${hex(region.base, 16)}  ${formatBytes(region.size).padStart(10)}  ${(MEMORY_STATES[region.state] ?? hex(region.state)).padEnd(9)}  ${(region.state === 0x10000 ? '' : describeProtection(region.protect)).padEnd(24)}  ${(MEMORY_TYPES[region.type] ?? '').padEnd(7)}  ${where(region.base) ?? ''}`),
        });
    }

    if (ranges.length) {
        sections.push({
            title: `Captured memory ranges (${ranges.length}, ${formatBytes(ranges.reduce((sum, range) => sum + range.size, 0))})  [start, size, what it is]`,
            lines: [...ranges].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).map((range) => `${hex(range.start, 16)}  ${formatBytes(range.size).padStart(10)}  ${where(range.start) ?? ''}`),
        });
    }

    if (handles.length) {
        sections.push({ title: `Open handles (${handles.length})  [handle, type, access, object name]`, lines: handles.map((handle) => `${hex(handle.handle)}  ${handle.type.padEnd(20)}  ${hex(handle.access, 8)}  ${handle.object}`) });
    }

    if (breakpadInfo) {
        sections.push({ title: 'Breakpad info', lines: [`Dump written by thread: ${threadLabel(breakpadInfo.dumpThread)}`, `Dump requested by thread: ${threadLabel(breakpadInfo.requestingThread)}`, `Validity flags: ${hex(breakpadInfo.validity)}`] });
    }

    if (linuxMaps?.length) {
        sections.push({ title: `Linux memory maps (${linuxMaps.length})`, lines: linuxMaps });
    }

    const exceptionText = exception ? exceptionName(exception, platform) : 'no exception record';
    return {
        kind,
        type: 'crashdump',
        engine: embedded ? embedded.context.engine : detection.engine,
        userName: embedded?.context.userName ?? null,
        userNames: environment?.identities ?? [],
        summary: {
            exception: embedded ? embedded.context.summary.exception : exceptionText,
            detail: embedded ? exceptionText : exceptionDetail,
            location,
            faultHint: faultHint ?? (faultModule ? moduleCategory(faultModule) : null),
            os,
            engineVersion: embedded ? embedded.context.summary.engineVersion : detection.version,
            backend: detection.backend,
            process: detection.executable ? `${detection.executable}${detection.game ? ` (${detection.game})` : ''}` : null,
            gpu: embedded?.context.summary.gpu ?? null,
            notes: [...detection.notes, ...(gpuStack.length ? [`Linux graphics: ${[...new Set(gpuStack)].join(', ')}`] : [])],
        },
        sections,
        warnings,
    };
}

module.exports = { SIGNATURE, parseMinidump };
