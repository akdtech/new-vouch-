const { SlashCommandBuilder } = require("discord.js");
const store = require("../moderationStore");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member.")
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),

  async execute(interaction) {
    if (!store.canModerate(interaction)) return interaction.reply({ content: "❌ You do not have permission to use moderation commands.", ephemeral: true });
    const member = interaction.options.getMember("user");
    if (!member?.bannable) return interaction.reply({ content: "❌ I cannot ban that member.", ephemeral: true });
    await member.ban({ reason: interaction.options.getString("reason") || "GMAO moderation" });
    return interaction.reply(`🔨 Banned **${member.user.tag}**.`);
  }
};
