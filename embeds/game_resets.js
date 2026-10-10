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

const GAMES = [
    { name: 'Genshin Impact', regions: [NA, EU, ASIA, SAR] },
    { name: 'Honkai: Star Rail', regions: [NA, EU, ASIA] },
    { name: 'Zenless Zone Zero', regions: [NA, EU, ASIA, SAR] },
    { name: 'Honkai Impact 3rd', regions: [NA, EU, { ...ASIA, name: 'SEA & 繁中' }, { name: 'JP & KR', offset: 9, weekday: MONDAY, colour: MAGENTA }] },
    { name: 'Wuthering Waves', regions: [{ ...NA, name: 'America' }, { ...ASIA, name: 'Asia' }, { ...EU, name: 'Europe' }, { ...SAR, name: 'HMT' }, { ...ASIA, name: 'SEA' }] },
    { name: 'Arknights: Endfield', regions: [{ ...NA, name: 'NA / EU', weekday: TUESDAY }, ASIA] },
];

function nextReset(now, offset, weekday = null) {
    const local = new Date(now + offset * HOUR);
    let reset = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), RESET_HOUR) - offset * HOUR;
    if (reset <= now) { reset += DAY; }
    if (weekday !== null) { reset += ((weekday - new Date(reset + offset * HOUR).getUTCDay() + 7) % 7) * DAY; }
    return Math.floor(reset / 1_000);
}

const formatClock = (now, offset) => new Date(now + offset * HOUR).toLocaleTimeString('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });

module.exports = {
    name: 'game_resets',
    description: 'Daily and weekly server resets per game.',
    refresh: 60,
    pages: GAMES.map((game) => ({
        name: game.name,
        build() {
            const now = Date.now();
            return new EmbedBuilder()
                .setTitle(`Game Status | ${game.name}`)
                .addFields(game.regions.map((region) => ({
                    name: region.name,
                    value: `\`\`\`ansi\n\u001b[1;${region.colour}m# ${formatClock(now, region.offset)}\u001b[0m\`\`\`• Daily reset <t:${nextReset(now, region.offset)}:R>\n• Weekly reset <t:${nextReset(now, region.offset, region.weekday)}:R>`,
                })));
        },
    })),
};
