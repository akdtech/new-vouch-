const { SlashCommandBuilder } = require("discord.js");
module.exports = {
  data: new SlashCommandBuilder().setName("skip").setDescription("Skip the current Discord voice track."),
  async execute(interaction, { music }) {
    await music.skip(interaction.guildId);
    return interaction.reply("⏭️ Skipped. DEATH is loading the next track.");
  }
};
