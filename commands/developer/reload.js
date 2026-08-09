const { SlashCommandBuilder, MessageFlags, PermissionsBitField} = require('discord.js');

module.exports = {
    cooldown: 1,
    developer: true,
    data: new SlashCommandBuilder().setName('reload').setDescription('Reloads a command.').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addStringOption((option) => option.setName('command').setDescription('The command to reload.').setRequired(true)),
    async execute(interaction) {
        const commandName = interaction.options.getString('command', true).toLowerCase();
        const command = interaction.client.commands.get(commandName);
        if (!command) { return interaction.reply({ content: `There is no command with name \`${commandName}\`!`, flags: MessageFlags.Ephemeral }); }
        if (!command.filePath) { return interaction.reply({ content: `Command \`${commandName}\` has no known file path and cannot be reloaded.`, flags: MessageFlags.Ephemeral }); }

        const { filePath } = command;
        delete require.cache[require.resolve(filePath)];

        try {
            const newCommand = require(filePath);
            newCommand.filePath = filePath;
            // The file may have been renamed since it was loaded; drop the stale key.
            if (newCommand.data.name !== commandName) { interaction.client.commands.delete(commandName); }
            interaction.client.commands.set(newCommand.data.name, newCommand);
            await interaction.reply({content: `Command \`${newCommand.data.name}\` was reloaded!`, flags: MessageFlags.Ephemeral });
        } catch (error) {
            console.error(error);
            interaction.client.commands.set(command.data.name, command);
            await interaction.reply({content: `There was an error while reloading a command \`${command.data.name}\`:\n\`${error.message}\``, flags: MessageFlags.Ephemeral });
        }
    },
};