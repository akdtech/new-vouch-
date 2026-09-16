const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current track."),

  async execute(interaction, { music }) {
    await music.skip(interaction.guildId);
    return interaction.reply("⏭️ Skipped the current track.");
  }
};
