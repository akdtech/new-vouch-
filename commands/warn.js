const { SlashCommandBuilder } = require("discord.js");
const store = require("../moderationStore");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member.")
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),

  async execute(interaction) {
    if (!store.canModerate(interaction)) {
      return interaction.reply({ content: "❌ You do not have permission to use moderation commands.", ephemeral: true });
    }
    const user = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason", true);
    const warnings = store.add(interaction.guildId, user.id, reason, interaction.user.id);
    return interaction.reply(`⚠️ ${user} has been warned. Total warnings: **${warnings.length}**.`);
  }
};
