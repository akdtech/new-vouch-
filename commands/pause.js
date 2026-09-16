const { SlashCommandBuilder } = require("discord.js");
module.exports = {
  data: new SlashCommandBuilder().setName("pause").setDescription("Pause music."),
  async execute(interaction, { music }) {
    await music.pause(interaction.guildId);
    return interaction.reply("⏸️ Music paused.");
  }
};
