const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("autoplay")
    .setDescription("Turn DEATH Music 24/7 autoplay on or off.")
    .addBooleanOption(option =>
      option
        .setName("enabled")
        .setDescription("Enable or disable autoplay")
        .setRequired(true)
    ),

  async execute(interaction, { music }) {
    const state = music.getState(interaction.guildId);
    state.autoplay = interaction.options.getBoolean("enabled", true);
    state.autoplayGeneration = (state.autoplayGeneration || 0) + 1;

    if (state.autoplay) {
      await music.autoplayNext(interaction.guildId).catch(() => {});
    }

    await music.refreshPanel(interaction.guildId).catch(() => {});

    return interaction.reply(
      `♾️ Autoplay is now **${state.autoplay ? "ON" : "OFF"}**.`
    );
  }
};
