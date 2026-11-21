const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { platforms, roles } = require('../linked_roles');
const { HEADERS, route, escapeHtml } = require('../utils/web');

const STATE_FILE = path.join(__dirname, '..', 'data', 'linked_roles.json');
const SESSION_TTL_MS = 30 * 60_000;
const flows = new Map();
const sessions = new Map();
const locks = new Map();

const baseUrl = () => process.env.WEB_PUBLIC_URL.replace(/\/+$/, '');
const randomToken = () => crypto.randomBytes(24).toString('base64url');

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch { return {}; }
}

function persist(users) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(users, null, 4), { mode: 0o600 });
    fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}

async function discord(endpoint, { token = null, method = 'GET', json = null, form = null } = {}) {
    const headers = { Authorization: token ? `Bearer ${token}` : `Bot ${process.env.DISCORD_TOKEN}`, 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' };
    const res = await fetch(`https://discord.com/api/v10${endpoint}`, { method, headers, body: form ? new URLSearchParams(form) : json ? JSON.stringify(json) : undefined, signal: AbortSignal.timeout(15_000) });
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) { throw Object.assign(new Error(`Discord ${method} ${endpoint} returned HTTP ${res.status}`), { status: res.status, body }); }
    return body;
}

async function grant(params) {
    const body = await discord('/oauth2/token', { method: 'POST', form: { client_id: process.env.DISCORD_APP_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, ...params } });
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000 };
}

const claimed = (users, platform, id, userId) => Object.entries(users).some(([otherId, user]) => otherId !== userId && user.accounts?.[platform]?.id === id);

function sync(userId) {
    const run = (locks.get(userId) ?? Promise.resolve()).catch(() => {}).then(async () => {
        const users = readState();
        const user = users[userId];
        if (!user) { return null; }
        try {
            if (user.tokens.expiresAt - Date.now() < 60_000) {
                user.tokens = await grant({ grant_type: 'refresh_token', refresh_token: user.tokens.refreshToken });
                persist(users);
            }
            const connections = await discord('/users/@me/connections', { token: user.tokens.accessToken });
            user.notes = [];
            for (const platform of platforms.values()) {
                if (!platform.connection) { continue; }
                const connection = connections.find((entry) => entry.type === platform.connection && entry.verified && !entry.revoked);
                user.accounts[platform.name] = connection && !claimed(users, platform.name, connection.id, userId) ? { id: connection.id, username: connection.name } : undefined;
                if (connection && !user.accounts[platform.name]) { user.notes.push(`This ${platform.connection} account is already linked to another Discord account.`); }
            }
            user.stats ??= {};
            for (const platform of platforms.values()) {
                const account = platform.discord ? { id: userId } : user.accounts[platform.name];
                if (!account) { delete user.stats[platform.name]; continue; }
                const stats = await platform.fetch(account).catch((error) => { console.error(`[linked_roles] ${platform.name} lookup for ${userId} failed:`, error.message); return undefined; });
                if (stats === undefined) { continue; }
                if (stats?.username) { account.username = stats.username; }
                user.stats[platform.name] = stats;
            }
            user.metadata = Object.fromEntries(roles.map((role) => [role.key, role.value(user.stats)]));
            const shown = Object.values(user.accounts).find(Boolean)?.username ?? user.username;
            await discord(`/users/@me/applications/${process.env.DISCORD_APP_ID}/role-connection`, { token: user.tokens.accessToken, method: 'PUT', json: { platform_name: 'Sandrone', platform_username: shown, metadata: Object.fromEntries(roles.map((role) => [role.key, String(user.metadata[role.key] ?? 0)])) } });
            user.updatedAt = new Date().toISOString();
            persist(users);
            return user;
        } catch (error) {
            if (error.status === 401 || error.body?.error === 'invalid_grant') {
                delete users[userId];
                persist(users);
                return null;
            }
            throw error;
        }
    });
    locks.set(userId, run);
    return run;
}

function page(res, title, user, message = '') {
    const accounts = user ? [...platforms.values()].map((platform) => {
        const account = user.accounts[platform.name];
        if (platform.discord) { return `<p>${escapeHtml(platform.name)}: donations count when you connect this Discord account on Ko-fi before donating.</p>`; }
        if (account) { return `<p>${escapeHtml(platform.name)}: <b>${escapeHtml(account.username)}</b></p>`; }
        if (platform.connection) { return `<p>${escapeHtml(platform.name)}: not linked. Add it under Discord <i>User Settings → Connections</i>, then open the link again.</p>`; }
        return platform.enabled?.() === false ? '' : `<p><a href="/linked-roles/${encodeURIComponent(platform.name)}">Connect ${escapeHtml(platform.name)}</a></p>`;
    }).join('') : '';
    const rows = user ? roles.map((role) => `<tr><td>${escapeHtml(role.name)}</td><td>${escapeHtml(user.metadata[role.key] ?? 0)}</td></tr>`).join('') : '';
    const notes = (user?.notes ?? []).map((note) => `<p class="note">${escapeHtml(note)}</p>`).join('');
    res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;background:#1e1f22;color:#dbdee1}a{color:#00a8fc}table{border-collapse:collapse;width:100%}td{padding:.4rem;border-bottom:1px solid #3f4147}.note{color:#f0b232}</style><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${notes}${accounts}${user ? `<table>${rows}</table><p>Go back to Discord and claim the role from the server's <i>Linked Roles</i> menu.</p>` : ''}`);
}

const redirect = (res, location, headers = {}) => res.writeHead(302, { ...HEADERS, Location: location, ...headers }).end();

function take(map, key) {
    const entry = map.get(key);
    map.delete(key);
    return entry && Date.now() - entry.created < 10 * 60_000 ? entry : null;
}

function session(req) {
    const entry = sessions.get(req.cookies.linked_roles);
    return entry && Date.now() - entry.created < SESSION_TTL_MS ? entry : null;
}

function registerRoutes() {
    route('/linked-roles', (req, res) => {
        const state = randomToken();
        flows.set(state, { created: Date.now() });
        redirect(res, `https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: process.env.DISCORD_APP_ID, response_type: 'code', redirect_uri: `${baseUrl()}/linked-roles/discord/callback`, scope: 'identify connections role_connections.write', state, prompt: 'consent' })}`);
    });

    route('/linked-roles/discord/callback', async (req, res) => {
        if (!req.query.get('code') || !take(flows, req.query.get('state'))) { return page(res, 'Link expired', null, 'Open the linked role link from Discord again.'); }
        const tokens = await grant({ grant_type: 'authorization_code', code: req.query.get('code'), redirect_uri: `${baseUrl()}/linked-roles/discord/callback` });
        const me = await discord('/users/@me', { token: tokens.accessToken });
        const users = readState();
        users[me.id] = { ...users[me.id], username: me.username, tokens, accounts: users[me.id]?.accounts ?? {}, metadata: users[me.id]?.metadata ?? {} };
        persist(users);
        const id = randomToken();
        sessions.set(id, { created: Date.now(), userId: me.id });
        res.setHeader('Set-Cookie', `linked_roles=${id}; Path=/linked-roles; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${baseUrl().startsWith('https://') ? '; Secure' : ''}`);
        page(res, 'Linked roles updated', await sync(me.id));
    });

    for (const platform of [...platforms.values()].filter((entry) => entry.webhook)) {
        route(`/linked-roles/${platform.name}/webhook`, async (req, res) => {
            const { status, userId } = platform.webhook(await req.body());
            res.writeHead(status, HEADERS).end();
            if (userId && readState()[userId]) { sync(userId).catch((error) => console.error(`[linked_roles] ${platform.name} webhook sync for ${userId} failed:`, error.message)); }
        }, 'POST');
    }

    for (const platform of [...platforms.values()].filter((entry) => entry.authorizeUrl && entry.enabled?.() !== false)) {
        const redirectUri = `${baseUrl()}/linked-roles/${platform.name}/callback`;

        route(`/linked-roles/${platform.name}`, (req, res) => {
            const current = session(req);
            if (!current) { return page(res, 'Session expired', null, 'Open the linked role link from Discord again first.'); }
            const state = randomToken();
            const verifier = crypto.randomBytes(48).toString('base64url');
            flows.set(state, { created: Date.now(), userId: current.userId, platform: platform.name, verifier });
            redirect(res, platform.authorizeUrl({ redirectUri, state, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }));
        });

        route(`/linked-roles/${platform.name}/callback`, async (req, res) => {
            const flow = take(flows, req.query.get('state'));
            if (flow?.platform !== platform.name || !req.query.get('code') || session(req)?.userId !== flow.userId) { return page(res, 'Link expired', null, 'Open the linked role link from Discord again.'); }
            const account = await platform.identify({ code: req.query.get('code'), redirectUri, verifier: flow.verifier });
            const users = readState();
            if (!users[flow.userId]) { return page(res, 'Link expired', null, 'Open the linked role link from Discord again.'); }
            if (claimed(users, platform.name, account.id, flow.userId)) { return page(res, 'Already linked', null, `This ${platform.name} account is already linked to another Discord account.`); }
            users[flow.userId].accounts[platform.name] = account;
            persist(users);
            page(res, 'Linked roles updated', await sync(flow.userId));
        });
    }
}

async function refreshAll() {
    let synced = 0;
    for (const userId of Object.keys(readState())) { synced += await sync(userId).then(Boolean).catch((error) => { console.error(`[linked_roles] refreshing ${userId} failed:`, error.message); return false; }); }
    return synced;
}

function start() {
    const missing = ['DISCORD_APP_ID', 'DISCORD_CLIENT_SECRET', 'WEB_PUBLIC_URL'].filter((key) => !process.env[key]);
    if (missing.length) { return console.log(`Linked roles disabled, missing ${missing.join(', ')}.`); }
    registerRoutes();
    discord(`/applications/${process.env.DISCORD_APP_ID}/role-connections/metadata`, { method: 'PUT', json: roles.map(({ key, name, description, type }) => ({ key, name, description, type })) })
        .then(() => console.log(`Registered ${roles.length} linked role(s).`))
        .catch((error) => console.error('[linked_roles] registering metadata failed:', error.message, JSON.stringify(error.body ?? '')));
    setInterval(() => refreshAll().catch(() => {}), (Number(process.env.DISCORD_LINKED_ROLES_REFRESH_HOURS) || 12) * 3_600_000);
}

module.exports = { start, sync, refreshAll };
