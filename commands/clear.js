const { SlashCommandBuilder } = require("discord.js");
const store = require("../moderationStore");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Delete messages.")
    .addIntegerOption(o => o.setName("amount").setDescription("1-100").setMinValue(1).setMaxValue(100).setRequired(true)),

  async execute(interaction) {
    if (!store.canModerate(interaction)) return interaction.reply({ content: "❌ You do not have permission to use moderation commands.", ephemeral: true });
    const amount = interaction.options.getInteger("amount", true);
    await interaction.channel.bulkDelete(amount, true);
    return interaction.reply({ content: `🧹 Deleted ${amount} messages.`, ephemeral: true });
  }
};
