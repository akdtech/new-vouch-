const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const store = require("../moderationStore");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("modrole")
    .setDescription("Choose the Discord role allowed to run moderation commands.")
    .addSubcommand(sub =>
      sub
        .setName("set")
        .setDescription("Set the moderation role.")
        .addRoleOption(option =>
          option.setName("role").setDescription("Moderation role").setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName("clear").setDescription("Remove the custom moderation role.")
    )
    .addSubcommand(sub =>
      sub.setName("status").setDescription("Show the current moderation role.")
    ),

  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: "❌ Only a server Administrator can change the moderation role.",
        ephemeral: true
      });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "set") {
      const role = interaction.options.getRole("role", true);
      store.setModRole(interaction.guildId, role.id);
      return interaction.reply(`🛡️ Moderation role set to ${role}.`);
    }

    if (sub === "clear") {
      store.clearModRole(interaction.guildId);
      return interaction.reply("🛡️ Custom moderation role cleared. Discord permissions will be used.");
    }

    const roleId = store.getModRole(interaction.guildId);
    return interaction.reply(
      roleId ? `🛡️ Current moderation role: <@&${roleId}>` : "🛡️ No custom moderation role is configured."
    );
  }
};
