const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop playback and clear the user queue."),

  async execute(interaction, { music }) {
    await music.stop(interaction.guildId);
    return interaction.reply(
      "⏹️ Playback stopped. The 24/7 connection remains in GMAO Music."
    );
  }
};
