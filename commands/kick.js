const { SlashCommandBuilder } = require("discord.js");
const store = require("../moderationStore");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member.")
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason")),

  async execute(interaction) {
    if (!store.canModerate(interaction)) return interaction.reply({ content: "❌ You do not have permission to use moderation commands.", ephemeral: true });
    const member = interaction.options.getMember("user");
    if (!member?.kickable) return interaction.reply({ content: "❌ I cannot kick that member.", ephemeral: true });
    await member.kick(interaction.options.getString("reason") || "GMAO moderation");
    return interaction.reply(`👢 Kicked **${member.user.tag}**.`);
  }
};
