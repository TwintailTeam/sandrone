const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATE_FILE = path.join(__dirname, '..', 'data', 'kofi_donations.json');

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch { return {}; }
}

function persist(donations) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(donations, null, 4), { mode: 0o600 });
    fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}

const matches = (given, expected) => typeof given === 'string' && given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));

module.exports = {
    name: 'kofi',
    discord: true,
    async fetch(account) {
        return Object.values(readState()).filter((donation) => donation.discordId === account.id && donation.currency === 'USD').reduce((sum, donation) => sum + donation.cents, 0);
    },
    webhook(body) {
        let payload = null;
        try {
            payload = JSON.parse(new URLSearchParams(body).get('data'));
        } catch { return { status: 400 }; }
        if (!process.env.KOFI_VERIFICATION_TOKEN || !matches(payload?.verification_token, process.env.KOFI_VERIFICATION_TOKEN)) { return { status: 401 }; }
        if (!['Tip', 'Donation', 'Subscription'].includes(payload.type) || !payload.discord_userid || !payload.kofi_transaction_id) { return { status: 200 }; }
        if (payload.currency !== 'USD') { console.warn(`[kofi] payment ${payload.kofi_transaction_id} is in ${payload.currency}, only USD counts toward donated; set Ko-fi to receive USD.`); }
        const donations = readState();
        donations[payload.kofi_transaction_id] = { discordId: payload.discord_userid, cents: Math.round(Number(payload.amount) * 100) || 0, currency: payload.currency, type: payload.type, timestamp: payload.timestamp };
        persist(donations);
        return { status: 200, userId: payload.discord_userid };
    },
};
