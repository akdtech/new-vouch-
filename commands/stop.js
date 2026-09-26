const { SlashCommandBuilder } = require("discord.js");
module.exports = {
  data: new SlashCommandBuilder().setName("stop").setDescription("Stop the current track and clear the queue."),
  async execute(interaction, { music }) {
    await music.stop(interaction.guildId);
    return interaction.reply("⏹️ Playback stopped. The 24/7 connection remains active.");
  }
};
