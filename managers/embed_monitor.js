const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const { types } = require('../embeds');

const MIN_REFRESH_SECONDS = 10;
const FATAL_EDIT_CODES = [10003, 10008, 50001, 50013];
const STATE_FILE = path.join(__dirname, '..', 'data', 'monitors.json');
const monitors = new Map();
const cache = new Map();

const clampRefresh = (type) => Math.max(type.refresh ?? 60, MIN_REFRESH_SECONDS);
const clampDataRefresh = (type) => Math.max(type.refreshData ?? clampRefresh(type), MIN_REFRESH_SECONDS);

async function getData(type, ctx, { maxAge = 0 } = {}) {
    if (typeof type.fetch !== 'function') { return { data: null, error: null, fetchedAt: Date.now() }; }

    const entry = cache.get(type.name) ?? { data: null, fetchedAt: 0, error: null, inFlight: null };
    if (entry.inFlight) { return entry.inFlight; }
    if (entry.fetchedAt && Date.now() - entry.fetchedAt < maxAge) { return entry; }

    entry.inFlight = (async () => {
        try {
            const data = await type.fetch(ctx);
            Object.assign(entry, { data, error: null, fetchedAt: Date.now() });
        } catch (error) {
            console.error(`[embed_monitor] fetch failed for ${type.name}:`, error);
            entry.error = error;
        }
        entry.inFlight = null;
        return entry;
    })();

    cache.set(type.name, entry);
    return entry.inFlight;
}

function persist() {
    const records = [...monitors].map(([messageId, m]) => ({ messageId, channelId: m.channelId, typeName: m.typeName, pageIndex: m.pageIndex }));
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(records, null, 4));
    } catch (error) { console.error('[embed_monitor] Failed to write state:', error); }
}

function readState() {
    try {
        const records = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return Array.isArray(records) ? records : [];
    } catch { return []; }
}

function buildPayload(type, pageIndex, ctx, { paused = false, entry = null } = {}) {
    const page = type.pages[pageIndex];
    const refresh = clampRefresh(type);
    const dataRefresh = clampDataRefresh(type);
    const rate = dataRefresh === refresh ? `every ${refresh}s` : `every ${refresh}s • data every ${dataRefresh}s`;
    const stale = entry?.error ? ' • stale' : '';

    let embed;
    try {
        embed = page.build({ ...ctx, data: entry?.data ?? null });
    } catch (error) {
        console.error(`[embed_monitor] page "${page.name}" of ${type.name} failed to render:`, error);
        embed = new EmbedBuilder().setTitle(page.name).setDescription('This page could not be rendered.');
    }

    embed.setColor(paused ? 0x99aab5 : 0x5865f2).setTimestamp(entry?.fetchedAt ?? Date.now()).setFooter({ text: `${type.name} • ${page.name} • page ${pageIndex + 1}/${type.pages.length} • ${paused ? 'paused' : rate}${stale}` });
    const id = (action, page_) => `embed:${type.name}:${action}:${page_}`;
    const prev = (pageIndex - 1 + type.pages.length) % type.pages.length;
    const next = (pageIndex + 1) % type.pages.length;

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(id('page', prev)).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(type.pages.length < 2),
        new ButtonBuilder().setCustomId('embed:noop').setLabel(page.name).setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId(id('page', next)).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(type.pages.length < 2),
        new ButtonBuilder().setCustomId(id('refresh', pageIndex)).setLabel('Refresh').setStyle(ButtonStyle.Success),
        paused ? new ButtonBuilder().setCustomId(id('start', pageIndex)).setLabel('Start').setStyle(ButtonStyle.Success) : new ButtonBuilder().setCustomId(id('stop', pageIndex)).setLabel('Stop').setStyle(ButtonStyle.Danger),
    );

    return { embeds: [embed], components: [row] };
}

function stop(messageId, { save = true } = {}) {
    const monitor = monitors.get(messageId);
    if (monitor) {
        clearInterval(monitor.timer);
        monitors.delete(messageId);
        if (save) { persist(); }
    }
}

function start({ channelId, messageId }, type, pageIndex, client, { save = true, immediate = false } = {}) {
    stop(messageId, { save: false });

    const tick = async () => {
        try {
            const channel = await client.channels.fetch(channelId);
            const live = await channel.messages.fetch(messageId);
            if (!monitors.has(messageId)) { return; }
            const entry = await getData(type, { client, guild: live.guild }, { maxAge: clampDataRefresh(type) * 1_000 - 1_500 });
            const monitor = monitors.get(messageId);
            if (!monitor) { return; }
            await live.edit(buildPayload(type, monitor.pageIndex, { client, guild: live.guild }, { entry }));
        } catch (error) {
            if (FATAL_EDIT_CODES.includes(error.code)) { stop(messageId); } else { console.error(error); }
        }
    };

    monitors.set(messageId, { timer: setInterval(tick, clampRefresh(type) * 1_000), channelId, typeName: type.name, pageIndex });
    if (save) { persist(); }
    if (immediate) { return tick(); }
}

async function restore(client) {
    for (const record of readState()) {
        const type = types.get(record.typeName);
        if (!type) { continue; }
        try {
            const channel = await client.channels.fetch(record.channelId);
            await channel.messages.fetch(record.messageId);
            await start(record, type, record.pageIndex % type.pages.length, client, { save: false, immediate: true });
        } catch (error) {
            if (!FATAL_EDIT_CODES.includes(error.code)) { console.error(error); }
        }
    }
    persist();
    if (monitors.size) { console.log(`Restored ${monitors.size} embed monitor(s).`); }
}


const isPaused = (message) => (message.components ?? []).some((row) => (row.components ?? []).some((c) => (c.customId ?? '').split(':')[2] === 'start'));
const GATED_ACTIONS = ['refresh', 'start', 'stop'];
const DEFAULT_BUTTON_COOLDOWNS = { page: 2, refresh: 15, start: 5, stop: 5 };
const buttonCooldowns = new Map();

function checkCooldown(type, action, interaction) {
    const seconds = type.cooldowns?.[action] ?? DEFAULT_BUTTON_COOLDOWNS[action] ?? 0;
    if (!seconds) { return null; }

    const key = `${interaction.message.id}:${action}:${interaction.user.id}`;
    const expiresAt = buttonCooldowns.get(key);
    if (expiresAt && Date.now() < expiresAt) { return Math.round(expiresAt / 1_000); }

    buttonCooldowns.set(key, Date.now() + seconds * 1_000);
    setTimeout(() => buttonCooldowns.delete(key), seconds * 1_000).unref();
    return null;
}

async function handleButton(interaction) {
    const [, typeName, action, page] = interaction.customId.split(':');
    if (action === undefined) { return interaction.deferUpdate(); }

    if (GATED_ACTIONS.includes(action) && interaction.user.id !== process.env.DISCORD_BOT_ADMIN) {
        return interaction.reply({ content: 'These controls are developer only.', flags: MessageFlags.Ephemeral });
    }

    const type = types.get(typeName);
    if (!type) { return interaction.update({ content: 'This embed type no longer exists.', embeds: [], components: [] }); }

    const readyAt = checkCooldown(type, action, interaction);
    if (readyAt) {
        return interaction.reply({ content: `Please wait, this button is on a cooldown. You can use it again <t:${readyAt}:R>.`, flags: MessageFlags.Ephemeral });
    }

    const pageIndex = Number(page) % type.pages.length;
    const ctx = { client: interaction.client, guild: interaction.guild };
    const target = { channelId: interaction.message.channelId, messageId: interaction.message.id };
    const entry = await getData(type, ctx, { maxAge: action === 'refresh' ? 0 : Infinity });

    if (action === 'stop') {
        stop(target.messageId);
        return interaction.update(buildPayload(type, pageIndex, ctx, { paused: true, entry }));
    }

    if (action === 'start') {
        await interaction.update(buildPayload(type, pageIndex, ctx, { entry }));
        return start(target, type, pageIndex, interaction.client);
    }

    const paused = isPaused(interaction.message);
    await interaction.update(buildPayload(type, pageIndex, ctx, { paused, entry }));

    if (paused) { return; }

    const monitor = monitors.get(target.messageId);
    if (monitor) {
        monitor.pageIndex = pageIndex;
        persist();
    } else {
        start(target, type, pageIndex, interaction.client);
    }
}

module.exports = { types, monitors, cache, getData, buildPayload, start, stop, restore, handleButton, checkCooldown, MIN_REFRESH_SECONDS, DEFAULT_BUTTON_COOLDOWNS, clampRefresh, clampDataRefresh };
