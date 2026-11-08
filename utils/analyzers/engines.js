const { basename } = require('./reader');

const UNITY = 'Unity';
const UNREAL = 'Unreal Engine';

const HOYOVERSE_GAMES = {
    'genshinimpact.exe': 'Genshin Impact',
    'yuanshen.exe': 'Yuanshen',
    'starrail.exe': 'Honkai: Star Rail',
    'zenlesszonezero.exe': 'Zenless Zone Zero',
    'bh3.exe': 'Honkai Impact 3rd',
};

const WINE_MODULES = new Set(['winex11.drv', 'winewayland.drv', 'winemac.drv', 'winepulse.drv', 'winealsa.drv', 'wineoss.drv', 'winebus.sys', 'lsteamclient.dll']);

const MODULE_HINTS = [
    [/^unityplayer\.dll$|^libunity\.so$|^unityframework$/, 'Unity engine (native engine code)'],
    [/^unity\.exe$/, 'Unity Editor'],
    [/^(gameassembly|userassembly)\.dll$|^libil2cpp\.so$/, 'IL2CPP game code (C# compiled to native)'],
    [/^mono(-2\.0-bdwgc|-2\.0-sgen)?\.dll$|^libmonobdwgc-2\.0\.so$|^libmonosgen-2\.0\.so$/, 'Mono runtime (managed C# code)'],
    [/^mhypbase\.dll$/, 'miHoYo protection module (mhypbase)'],
    [/-(win64|win32)-(shipping|test|development|debuggame)\.exe$/, 'Unreal Engine game executable'],
    [/^(ue4editor|unrealeditor)-.+\.dll$|^(ue4editor|unrealeditor)\.exe$/, 'Unreal Editor module'],
    [/^nv(wgf2um|wgf2umx|d3dum|d3dumx|oglv32|oglv64|ldumd|ldumdx|apo64|gpucomp64|warp64)\.dll$/, 'NVIDIA GPU driver'],
    [/^(amdxx64|amdxx32|atiumd64|atiumdag|atidxx64|atidxx32|amdvlk64|amdvlk32|atio6axx|atiadlxx|amdxc64|amd_ags_x64)\.dll$/, 'AMD GPU driver'],
    [/^(igd10iumd64|igd10iumd32|igd12umd64|igdumdim64|igxelpicd64|igvk64|igc64|ig9icd64|igdgmm64)\.dll$/, 'Intel GPU driver'],
    [/^(d3d11|d3d12|d3d12core|dxgi|d3d9|d3dcompiler_47)\.dll$/, 'Direct3D runtime (DXVK/VKD3D-Proton when running under Wine)'],
    [/^libvulkan_radeon\.so/, 'Mesa RADV (AMD Vulkan driver)'],
    [/^libvulkan_intel(_hasvk)?\.so/, 'Mesa ANV (Intel Vulkan driver)'],
    [/^libvulkan_nouveau\.so/, 'Mesa NVK (NVIDIA open Vulkan driver)'],
    [/^libvulkan_lvp\.so/, 'Mesa lavapipe (software Vulkan, no GPU)'],
    [/^libvulkan_virtio\.so|^libvulkan_dzn\.so/, 'Mesa virtualized Vulkan driver'],
    [/^(libnvidia-(glcore|eglcore|gpucomp|vulkan|tls|rtcore)|libGLX_nvidia|libnvidia-glvkspirv)\.so/, 'NVIDIA proprietary Linux driver'],
    [/^(radeonsi|iris|crocus|i965|nouveau|zink|swrast|kms_swrast|llvmpipe)_dri\.so|^libgallium/, 'Mesa OpenGL driver'],
    [/^vulkan-1\.dll$|^libvulkan\.so/, 'Vulkan loader'],
    [/^(ntdll|kernelbase|kernel32|ucrtbase|msvcrt|vcruntime140|msvcp140)\.dll$|^libc\.so|^libpthread\.so/, 'OS / C runtime library'],
    [/^(easyanticheat.*|eac.*|beclient.*|eossdk-win64-shipping|gameguard.*|xigncode.*)\.(dll|des)$/i, 'Anti-cheat or online services SDK'],
    [/^(steam_api64|steam_api|steamclient64|gameoverlayrenderer64|discord_game_sdk|rtsshooks64|nvspcap64|obs-vulkan64|graphics-hook64)\.dll$/, 'Overlay / platform SDK'],
];

function moduleHint(name) {
    const file = basename(name).toLowerCase();
    return MODULE_HINTS.find(([pattern]) => pattern.test(file))?.[1] ?? null;
}

const formatVersion = (version) => version && `${version.major}.${version.minor}.${version.build}.${version.revision}`;

const isUnityVersion = (version) => Boolean(version) && (version.major === 5 || (version.major >= 2017 && version.major <= 2023) || version.major >= 6000);

const unityVersion = (module) => (isUnityVersion(module?.version) ? `Unity ${module.version.major}.${module.version.minor}.${module.version.build}` : null);

function detectFromModules(modules, threadNames = []) {
    const byName = new Map(modules.map((module) => [basename(module.name).toLowerCase(), module]));
    const find = (pattern) => modules.find((module) => pattern.test(basename(module.name).toLowerCase()));
    const executable = modules[0] ? basename(modules[0].name) : null;
    const notes = [];

    const game = executable ? HOYOVERSE_GAMES[executable.toLowerCase()] : undefined;
    const wine = modules.filter((module) => WINE_MODULES.has(basename(module.name).toLowerCase())).map((module) => basename(module.name));
    if (wine.length) { notes.push(`Running under Wine/Proton (${wine.join(', ')})`); }

    const unityPlayer = byName.get('unityplayer.dll') ?? find(/^libunity\.so$/);
    const unityEditor = byName.get('unity.exe');
    const il2cpp = find(/^(gameassembly|userassembly)\.dll$|^libil2cpp\.so$/);
    const mono = find(/^mono(-2\.0-bdwgc|-2\.0-sgen)?\.dll$|^libmono(bdwgc|sgen)-2\.0\.so$/);
    const unityData = modules.some((module) => /_data[\\/](mono|plugins|managed)[\\/]/i.test(module.name));
    const unityThreads = threadNames.some((name) => /^(Unity|IL2CPP )/.test(name));
    const il2cppThreads = threadNames.some((name) => /^IL2CPP /.test(name));

    if (unityPlayer || unityEditor || il2cpp || unityData || unityThreads) {
        const backend = il2cpp ? `IL2CPP (${basename(il2cpp.name)})` : il2cppThreads ? 'IL2CPP (linked into the executable)' : mono ? `Mono (${basename(mono.name)})` : null;
        const host = unityEditor ?? unityPlayer ?? modules[0];
        const where = unityEditor ? 'Editor' : unityPlayer ? basename(unityPlayer.name) : `engine linked into ${executable ?? 'the executable'}`;
        const version = `${unityVersion(host) ?? 'version unknown'} (${where}${host?.version ? `, file version ${formatVersion(host.version)}` : ''})`;
        return { engine: UNITY, version, backend, executable, game, notes };
    }

    const unrealExe = find(/-(win64|win32)-(shipping|test|development|debuggame)\.exe$/);
    const unrealModule = find(/^(ue4editor|unrealeditor|ue4game|ue4server|ue4client)[-.]/);
    const unrealTree = modules.some((module) => /[\\/]engine[\\/](binaries|plugins)[\\/]/i.test(module.name));
    if (unrealExe || unrealModule || unrealTree) {
        const generation = unrealModule ? (/^unrealeditor/.test(basename(unrealModule.name).toLowerCase()) ? 'Unreal Engine 5' : 'Unreal Engine 4') : null;
        const version = generation ?? 'monolithic build (version is in CrashContext.runtime-xml, not the dump)';
        return { engine: UNREAL, version, backend: null, executable, game, notes };
    }

    return { engine: null, version: null, backend: null, executable, game, notes };
}

module.exports = { UNITY, UNREAL, moduleHint, detectFromModules, formatVersion };
