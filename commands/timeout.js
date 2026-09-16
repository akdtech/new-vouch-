const { SlashCommandBuilder } = require("discord.js");
const store = require("../moderationStore");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a member.")
    .addUserOption(o => o.setName("user").setDescription("Member").setRequired(true))
    .addIntegerOption(o => o.setName("minutes").setDescription("1-10080").setMinValue(1).setMaxValue(10080).setRequired(true)),

  async execute(interaction) {
    if (!store.canModerate(interaction)) return interaction.reply({ content: "❌ You do not have permission to use moderation commands.", ephemeral: true });
    const member = interaction.options.getMember("user");
    const minutes = interaction.options.getInteger("minutes", true);
    if (!member?.moderatable) return interaction.reply({ content: "❌ I cannot timeout that member.", ephemeral: true });
    await member.timeout(minutes * 60000, "GMAO moderation");
    return interaction.reply(`⏳ ${member} timed out for **${minutes} minute(s)**.`);
  }
};
