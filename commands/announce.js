const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");
const store = require("../moderationStore");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Send a GMAO announcement.")
    .addStringOption(o =>
      o.setName("message").setDescription("Announcement").setRequired(true)
    ),

  async execute(interaction) {
    if (!store.canModerate(interaction)) {
      return interaction.reply({
        content: "❌ You do not have permission to use moderation commands.",
        ephemeral: true
      });
    }

    const embed = new EmbedBuilder()
      .setTitle("📢 GMAO Announcement")
      .setDescription(interaction.options.getString("message", true))
      .setFooter({ text: "DEATH × GMAO" })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
};
