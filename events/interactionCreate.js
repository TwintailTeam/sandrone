const { Events, MessageFlags, Collection } = require('discord.js');
const { handleButton } = require('../managers/embed_monitor');

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        if (interaction.isButton()) {
            if (!interaction.customId.startsWith('embed:')) { return; }
            try {
                return await handleButton(interaction);
            } catch (error) {
                console.error(error);
                if (!interaction.replied && !interaction.deferred) { return interaction.reply({ content: 'There was an error while updating this embed!', flags: MessageFlags.Ephemeral }); }
                return;
            }
        }

        if (!interaction.isChatInputCommand() && !interaction.isUserContextMenuCommand()) return;

        const command = interaction.client.commands.get(interaction.commandName);
        if (!command) return;

        const { cooldowns } = interaction.client;
        if (!cooldowns.has(command.data.name)) { cooldowns.set(command.data.name, new Collection()); }

        const now = Date.now();
        const timestamps = cooldowns.get(command.data.name);
        const defaultCooldownDuration = 3;
        const cooldownAmount = (command.cooldown ?? defaultCooldownDuration) * 1_000;

        if (timestamps.has(interaction.user.id)) {
            const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;

            if (now < expirationTime) {
                const expiredTimestamp = Math.round(expirationTime / 1_000);
                return interaction.reply({ content: `Please wait, you are on a cooldown for \`${command.data.name}\`. You can use it again <t:${expiredTimestamp}:R>.`, flags: MessageFlags.Ephemeral });
            }
        }

        timestamps.set(interaction.user.id, now);
        setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

        try {
            if (command.developer && interaction.user.id !== process.env.DISCORD_BOT_ADMIN) {
                if (interaction.replied || interaction.deferred) {
                    return await interaction.followUp({ content: 'Developer only command!', flags: MessageFlags.Ephemeral });
                } else {
                    return await interaction.reply({ content: 'Developer only command!', flags: MessageFlags.Ephemeral});
                }
            }
            await command.execute(interaction);
        } catch (error) {
            console.error(error);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
            } else {
                await interaction.reply({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral});
            }
        }
    },
};
