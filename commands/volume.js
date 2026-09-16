const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Set DEATH Music volume.")
    .addIntegerOption(option =>
      option
        .setName("level")
        .setDescription("1-100")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true)
    ),

  async execute(interaction, { music }) {
    const level = interaction.options.getInteger("level", true);
    const volume = await music.setVolume(interaction.guildId, level);
    return interaction.reply(`🔊 Volume set to **${volume}%**.`);
  }
};
