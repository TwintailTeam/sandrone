const { Events, ActivityType} = require('discord.js');
const { restore } = require('../managers/embed_monitor');

module.exports = {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        console.log(`Ready! Logged in as ${client.user.tag}`);
        await restore(client);
        client.user.setPresence({ activities: [{ name: 'Columbina sleep!', type: ActivityType.Watching }], status: 'dnd' });
    },
};
