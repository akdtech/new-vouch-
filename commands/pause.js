const { SlashCommandBuilder } = require("discord.js");
module.exports = {
  data: new SlashCommandBuilder().setName("pause").setDescription("Pause Discord voice playback."),
  async execute(i, { music }) {
    await music.pause(i.guildId);
    return i.reply("⏸️ Music paused in the Discord voice channel.");
  }
};
