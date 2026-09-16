const { SlashCommandBuilder } = require("discord.js");
const store = require("../moderationStore");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("Show warnings for a member.")
    .addUserOption(option =>
      option.setName("user").setDescription("Member").setRequired(true)
    ),

  async execute(interaction) {
    if (!store.canModerate(interaction)) {
      return interaction.reply({ content: "❌ You do not have permission to use moderation commands.", ephemeral: true });
    }
    const user = interaction.options.getUser("user", true);
    const warnings = store.get(interaction.guildId, user.id);
    if (!warnings.length) return interaction.reply(`✅ ${user} has no warnings.`);
    return interaction.reply(
      `⚠️ ${user} has **${warnings.length}** warning(s).\n` +
      warnings.slice(-10).map((w, i) => `${i + 1}. ${w.reason}`).join("\n")
    );
  }
};
