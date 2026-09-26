const { SlashCommandBuilder } = require("discord.js");
module.exports = {
  data: new SlashCommandBuilder().setName("resume").setDescription("Resume Discord voice playback."),
  async execute(i, { music }) {
    await music.resume(i.guildId);
    return i.reply("▶️ Music resumed in the Discord voice channel.");
  }
};
