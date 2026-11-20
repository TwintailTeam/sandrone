const { SlashCommandBuilder, MessageFlags, PermissionsBitField } = require('discord.js');
const { sync, refreshAll } = require('../../managers/linked_roles');
const { empty } = require('../../managers/empty_role');

module.exports = {
    cooldown: 3,
    developer: false,
    data: new SlashCommandBuilder().setName('admin').setDescription('Server administration tools.').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addSubcommand((subcommand) => subcommand.setName('synclinkedroles').setDescription('Resyncs linked role values for one user or everyone.')
            .addUserOption((option) => option.setName('user').setDescription('Only resync this user.')))
        .addSubcommand((subcommand) => subcommand.setName('emptyrole').setDescription('Removes a role from everyone who has it and gives it back after a while.')
            .addRoleOption((option) => option.setName('role').setDescription('The role to empty.').setRequired(true))
            .addIntegerOption((option) => option.setName('minutes').setDescription('How long the role stays empty.').setRequired(true).setMinValue(1).setMaxValue(10080))),
    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (interaction.options.getSubcommand() === 'synclinkedroles') {
            const user = interaction.options.getUser('user');
            if (!user) { return interaction.editReply({ content: `Resynced linked roles for ${await refreshAll()} user(s).` }); }
            const record = await sync(user.id);
            return interaction.editReply({ content: record ? `Resynced linked roles for ${user}.` : `${user} has not linked their account.` });
        }

        const role = interaction.options.getRole('role', true);
        const minutes = interaction.options.getInteger('minutes', true);
        if (role.managed || role.id === interaction.guild.id) { return interaction.editReply({ content: `${role} is managed by Discord or an integration and can't be emptied.` }); }
        if (role.position >= interaction.guild.members.me.roles.highest.position) { return interaction.editReply({ content: `${role} is above my highest role, move my role above it first.` }); }
        try {
            const { removed, restoreAt } = await empty(role, minutes);
            await interaction.editReply({ content: `Removed ${role} from ${removed} member(s). It will be given back <t:${Math.floor(restoreAt / 1000)}:R>.` });
        } catch (error) {
            await interaction.editReply({ content: error.message });
        }
    },
};
