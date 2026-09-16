const { SlashCommandBuilder, EmbedBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("commands")
    .setDescription("Open the DEATH × GMAO command center."),

  async execute(interaction, { client }) {
    const embed = new EmbedBuilder()
      .setTitle("💀 DEATH × GMAO — Command Center")
      .setDescription(
        "Use the command picker below Discord's slash-command box to find every feature."
      )
      .addFields(
        {
          name: "🎵 Music",
          value: "`/play` `/queue` `/nowplaying` `/pause` `/resume` `/skip` `/stop` `/shuffle` `/loop` `/volume` `/seek` `/remove` `/autoplay` `/musicpanel` `/musicinfo`",
          inline: false
        },
        {
          name: "♾️ 24/7",
          value: "The bot automatically reconnects to **GMAO Music** and keeps autoplay running when enabled.",
          inline: false
        },
        {
          name: "🛡️ Moderation",
          value: "Moderation commands remain permission-controlled. The configured moderation role can be managed from Discord.",
          inline: false
        },
        {
          name: "📦 Commands loaded",
          value: String(client.commands.size),
          inline: true
        }
      )
      .setFooter({ text: "DEATH × GMAO • Music • Community • Security" })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
};
