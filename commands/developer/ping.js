const { SlashCommandBuilder, MessageFlags, PermissionsBitField} = require('discord.js');

module.exports = {
    cooldown: 5,
    developer: true,
    data: new SlashCommandBuilder().setName('ping').setDescription('Replies with Pong!').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    async execute(interaction) {
        await interaction.reply({ content: `Replies with pong!`, flags: MessageFlags.Ephemeral });
    },
};