const { EmbedBuilder } = require('discord.js');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RESET_HOUR = 4;
const MONDAY = 1;
const TUESDAY = 2;

const BLUE = 34;
const GREEN = 32;
const YELLOW = 33;
const RED = 31;
const MAGENTA = 35;

const NA = { name: 'NA', offset: -5, weekday: MONDAY, colour: BLUE };
const EU = { name: 'EU', offset: 1, weekday: MONDAY, colour: GREEN };
const ASIA = { name: 'ASIA', offset: 8, weekday: MONDAY, colour: YELLOW };
const SAR = { name: 'SAR', offset: 8, weekday: MONDAY, colour: RED };

const BRANCHES_URL = 'https://sg-hyp-api.hoyoverse.com/hyp/hyp-connect/api/getGameBranches?launcher_id=VYTpXlbWo8';
const REQUEST_TIMEOUT = 15_000;
const SECURITY_FILE_MISSING = 8;

const hasJsonSecurityFile = (prefix) => (body, version) => {
    const json = JSON.parse(body);
    if (json.retcode === SECURITY_FILE_MISSING) { return false; }
    const file = json[`${prefix}${version}`];
    if (typeof file !== 'string') { throw new Error(`Unexpected security file response: ${body.slice(0, 100)}`); }
    return file.length > 0;
};

const GAMES = [
    { name: 'Genshin Impact', regions: [NA, EU, ASIA, SAR], security: { biz: 'hk4e_global', url: (version) => `https://dispatchosglobal.yuanshen.com/query_security_file?file_key=OSRELWin${version}` } },
    { name: 'Honkai: Star Rail', regions: [NA, EU, ASIA], security: { biz: 'hkrpg_global', url: (version) => `https://globaldp-prod-os01.starrails.com/query_security_file?file_key=OSPRODWin${version}`, found: hasJsonSecurityFile('OSPRODWin') } },
    { name: 'Zenless Zone Zero', regions: [NA, EU, ASIA, SAR], security: { biz: 'nap_global', url: (version) => `https://globaldp-prod-os01.zenlesszonezero.com/query_security_file?file_key=OSPRODWin${version}` } },
    { name: 'Honkai Impact 3rd', regions: [NA, EU, { ...ASIA, name: 'SEA & 繁中' }, { name: 'JP & KR', offset: 9, weekday: MONDAY, colour: MAGENTA }] },
    { name: 'Wuthering Waves', regions: [{ ...NA, name: 'America' }, { ...ASIA, name: 'Asia' }, { ...EU, name: 'Europe' }, { ...SAR, name: 'HMT' }, { ...ASIA, name: 'SEA' }] },
    { name: 'Punishing: Gray Raven', regions: [{ name: 'Global', offset: 0, hour: 7, weekday: MONDAY, colour: BLUE }], note: 'Reset times come from community sources and are not officially confirmed by Kuro Games.' },
    { name: 'Arknights: Endfield', regions: [{ ...NA, name: 'NA / EU', weekday: TUESDAY }, ASIA] },
];

function nextReset(now, offset, hour, weekday = null) {
    const local = new Date(now + offset * HOUR);
    let reset = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour) - offset * HOUR;
    if (reset <= now) { reset += DAY; }
    if (weekday !== null) { reset += ((weekday - new Date(reset + offset * HOUR).getUTCDay() + 7) % 7) * DAY; }
    return Math.floor(reset / 1_000);
}

const formatClock = (now, offset) => new Date(now + offset * HOUR).toLocaleTimeString('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });

const BRANCHES_TTL = 3 * HOUR;
const BRANCHES_PREDOWNLOAD_TTL = HOUR / 6;
const BRANCHES_RECHECK = HOUR / 2;
const TRACKED_BIZ = new Set(GAMES.filter((game) => game.security).map((game) => game.security.biz));
const branches = { tags: null, preDownload: false, fetchedAt: 0, inFlight: null };

async function request(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
    if (!res.ok) { throw new Error(`HTTP ${res.status} from ${url}`); }
    return res;
}

class VersionLookupError extends Error {}

async function getTags({ recheck = false } = {}) {
    const ttl = recheck ? BRANCHES_RECHECK : branches.preDownload ? BRANCHES_PREDOWNLOAD_TTL : BRANCHES_TTL;
    if (branches.tags && Date.now() - branches.fetchedAt < ttl) { return branches.tags; }
    branches.inFlight ??= (async () => {
        try {
            const body = await (await request(BRANCHES_URL)).json();
            if (body.retcode !== 0) { throw new Error(`getGameBranches retcode ${body.retcode}: ${body.message}`); }
            branches.tags = new Map(body.data.game_branches.map((branch) => [branch.game.biz, branch.main.tag]));
            branches.preDownload = body.data.game_branches.some((branch) => TRACKED_BIZ.has(branch.game.biz) && branch.pre_download);
            branches.fetchedAt = Date.now();
        } catch (error) {
            throw new VersionLookupError(`getGameBranches failed: ${error.message}`, { cause: error });
        } finally {
            branches.inFlight = null;
        }
        return branches.tags;
    })();
    return branches.inFlight;
}

async function hasSecurityFile(game, tags) {
    const version = tags.get(game.security.biz);
    if (!version) { throw new VersionLookupError(`No ${game.security.biz} branch in getGameBranches`); }
    const body = await (await request(game.security.url(version))).text();
    return { version, found: game.security.found ? game.security.found(body, version) : body.length > 0 };
}

async function checkBootable(game) {
    try {
        let result = await hasSecurityFile(game, await getTags());
        if (!result.found) {
            const latest = await getTags({ recheck: true });
            if (latest.get(game.security.biz) !== result.version) { result = await hasSecurityFile(game, latest); }
        }
        return result.found ? 'Yes' : 'No';
    } catch (error) {
        console.error(`[game_resets] bootable check failed for ${game.name}:`, error);
        return error instanceof VersionLookupError ? 'Version lookup failure' : 'Unknown';
    }
}

module.exports = {
    name: 'game_resets',
    description: 'Daily and weekly server resets per game.',
    refresh: 60,
    refreshData: 600,
    async fetch() {
        const games = GAMES.filter((game) => game.security);
        return Object.fromEntries(await Promise.all(games.map(async (game) => [game.name, await checkBootable(game)])));
    },
    pages: GAMES.map((game) => ({
        name: game.name,
        build({ data }) {
            const now = Date.now();
            const embed = new EmbedBuilder().setTitle(`Game Status | ${game.name}`);
            const bootable = game.security ? data?.[game.name] ?? 'Unknown' : 'Yes';
            embed.setDescription([game.note, `Linux bootable: \`${bootable}\``].filter(Boolean).join('\n'));
            return embed
                .addFields(game.regions.map((region) => ({
                    name: region.name,
                    value: `\`\`\`ansi\n\u001b[1;${region.colour}m# ${formatClock(now, region.offset)}\u001b[0m\`\`\`• Daily reset <t:${nextReset(now, region.offset, region.hour ?? RESET_HOUR)}:R>\n• Weekly reset <t:${nextReset(now, region.offset, region.hour ?? RESET_HOUR, region.weekday)}:R>`,
                })));
        },
    })),
};
