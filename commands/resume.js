const { SlashCommandBuilder } = require("discord.js");
module.exports = {
  data: new SlashCommandBuilder().setName("resume").setDescription("Resume music."),
  async execute(interaction, { music }) {
    await music.resume(interaction.guildId);
    return interaction.reply("▶️ Music resumed.");
  }
};
