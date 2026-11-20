const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'empty_roles.json');

function readState() {
    try {
        const records = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return Array.isArray(records) ? records : [];
    } catch { return []; }
}

function persist(records) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(records, null, 4));
}

async function giveBack(client, record) {
    try {
        const guild = await client.guilds.fetch(record.guildId);
        for (const memberId of record.memberIds) { await guild.members.addRole({ user: memberId, role: record.roleId, reason: 'Emptied role restored' }).catch((error) => console.error(`[empty_role] could not give ${record.roleId} back to ${memberId}:`, error.message)); }
    } finally {
        persist(readState().filter((entry) => !(entry.guildId === record.guildId && entry.roleId === record.roleId)));
    }
}

const schedule = (client, record) => setTimeout(() => giveBack(client, record).catch((error) => console.error('[empty_role] restoring failed:', error)), Math.max(0, record.restoreAt - Date.now()));

async function empty(role, minutes) {
    if (readState().some((entry) => entry.guildId === role.guild.id && entry.roleId === role.id)) { throw new Error(`${role.name} is already emptied.`); }
    const members = await role.guild.members.fetch();
    const holders = members.filter((member) => member.roles.cache.has(role.id));
    const record = { guildId: role.guild.id, roleId: role.id, memberIds: [...holders.keys()], restoreAt: Date.now() + minutes * 60_000 };
    persist([...readState(), record]);
    let removed = 0;
    for (const member of holders.values()) { removed += await member.roles.remove(role, `Role emptied for ${minutes} minute(s)`).then(() => 1).catch((error) => { console.error(`[empty_role] could not remove ${role.id} from ${member.id}:`, error.message); return 0; }); }
    schedule(role.client, record);
    return { removed, restoreAt: record.restoreAt };
}

function restore(client) {
    const records = readState();
    for (const record of records) { schedule(client, record); }
    if (records.length) { console.log(`Restored ${records.length} emptied role timer(s).`); }
}

module.exports = { empty, restore };
