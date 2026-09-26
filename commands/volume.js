const { SlashCommandBuilder } = require("discord.js");
module.exports = {
  data: new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Set Discord voice music volume.")
    .addIntegerOption(option => option.setName("level").setDescription("1-100").setMinValue(1).setMaxValue(100).setRequired(true)),
  async execute(interaction, { music }) {
    const level = interaction.options.getInteger("level", true);
    const actual = await music.setVolume(interaction.guildId, level);
    return interaction.reply(`🔊 Discord music volume set to **${actual}%**.`);
  }
};
