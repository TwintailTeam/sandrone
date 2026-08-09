const { SlashCommandBuilder, MessageFlags, PermissionsBitField } = require('discord.js');
const { types, buildPayload, getData, start } = require('../../managers/embed_monitor');

module.exports = {
    cooldown: 1,
    developer: true,
    data: new SlashCommandBuilder().setName('embed').setDescription('Posts a self-refreshing, pageable monitor embed.').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addStringOption((option) => option.setName('type').setDescription('The monitor to post.').setRequired(true)
            .addChoices(...[...types.values()].map((type) => ({ name: type.name, value: type.name })))),
    async execute(interaction) {
        const type = types.get(interaction.options.getString('type', true));
        if (!type) { return interaction.reply({ content: 'Unknown embed type.', flags: MessageFlags.Ephemeral }); }

        // Deferred because the type's first fetch may outlast the 3s reply window.
        await interaction.deferReply();
        const ctx = { client: interaction.client, guild: interaction.guild };
        const entry = await getData(type, ctx, { maxAge: 0 });

        const message = await interaction.editReply(buildPayload(type, 0, ctx, { entry }));
        start({ channelId: message.channelId, messageId: message.id }, type, 0, interaction.client);
    },
};
