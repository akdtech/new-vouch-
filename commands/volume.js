const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Set Spotify playback volume.")
    .addIntegerOption(option =>
      option.setName("level")
        .setDescription("1-100")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true)
    ),
  async execute(interaction) {
    const level = interaction.options.getInteger("level", true);
    await interaction.client.spotify.volume(interaction.guildId, interaction.user.id, level);
    return interaction.reply(`🔊 Spotify volume set to **${level}%**.`);
  }
};
