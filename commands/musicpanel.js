const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("musicpanel")
    .setDescription("Create the DEATH Music controls in GMAO Music."),

  async execute(interaction, { music }) {
    try {
      const message = await music.sendPanel(interaction.guildId);
      return interaction.reply({
        content: `✅ Music panel created in <#${message.channelId}>.`,
        ephemeral: true
      });
    } catch (error) {
      return interaction.reply({
        content: `❌ ${error?.message || "Could not create the music panel."}`,
        ephemeral: true
      });
    }
  }
};
