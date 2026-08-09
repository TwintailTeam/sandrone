const { EmbedBuilder } = require('discord.js');

const formatUptime = (ms) => {
    const s = Math.floor(ms / 1_000);
    return `${Math.floor(s / 86400)}d ${Math.floor(s / 3600) % 24}h ${Math.floor(s / 60) % 60}m ${s % 60}s`;
};

module.exports = {
    name: 'server_status',
    description: 'Live server and bot status.',
    refresh: 30,

    // Optional. Seconds between fetch() calls, defaulting to `refresh`. Set it
    // higher to redraw often while hitting a slow or rate-limited API rarely —
    // e.g. refresh: 30 with refreshData: 600 redraws every 30s but calls the
    // API every 10 minutes, the pages in between rendering the cached result.
    // Setting it below `refresh` does nothing: a fetch only happens on a redraw.
    // refreshData: 600,

    // Optional per-button cooldowns in seconds, per user, per message. Omitted
    // actions fall back to DEFAULT_BUTTON_COOLDOWNS in the monitor.
    // cooldowns: { page: 2, refresh: 15, start: 5, stop: 5 },

    // Optional. Called at most once per `refreshData` no matter how many monitors
    // of this type are running, and never on a page turn — put API calls here, not
    // in build(). Whatever it returns arrives as ctx.data. Throwing keeps the
    // last good data and marks the embed stale rather than blanking it.
    //
    // The result is cached per type, shared by every monitor of that type in
    // every guild, so fetch() must not depend on ctx.guild — put guild-specific
    // work in build(), which runs per render.
    //
    //   async fetch() {
    //       const res = await fetch('https://api.example.com/status');
    //       if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
    //       return res.json();
    //   },
    //
    // This type reads local gateway state, so it needs no fetch and ctx.data is null.

    // Add or remove pages by editing this array. Each page is { name, build(ctx) },
    // where ctx is { client, guild, data }. build must be synchronous and must not
    // do I/O. The monitor sets colour, footer and timestamp, overwriting any the
    // page sets itself.
    pages: [
        {
            name: 'Overview',
            build({ guild }) {
                return new EmbedBuilder()
                    .setTitle(`${guild.name} — Overview`)
                    .setThumbnail(guild.iconURL())
                    .addFields(
                        { name: 'Members', value: `${guild.memberCount}`, inline: true },
                        { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
                        { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1_000)}:R>`, inline: true },
                    );
            },
        },
        {
            name: 'Channels & Roles',
            build({ guild }) {
                const channels = guild.channels.cache;
                return new EmbedBuilder()
                    .setTitle(`${guild.name} — Channels & Roles`)
                    .addFields(
                        { name: 'Channels', value: `${channels.size}`, inline: true },
                        { name: 'Roles', value: `${guild.roles.cache.size}`, inline: true },
                        { name: 'Emojis', value: `${guild.emojis.cache.size}`, inline: true },
                    );
            },
        },
        {
            name: 'Bot Health',
            build({ client }) {
                const heap = process.memoryUsage().heapUsed / 1024 / 1024;
                return new EmbedBuilder()
                    .setTitle('Bot Health')
                    .addFields(
                        { name: 'Gateway ping', value: `${client.ws.ping}ms`, inline: true },
                        { name: 'Uptime', value: formatUptime(client.uptime), inline: true },
                        { name: 'Heap used', value: `${heap.toFixed(1)} MB`, inline: true },
                    );
            },
        },
    ],
};
