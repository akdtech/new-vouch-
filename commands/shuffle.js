const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Toggle Spotify shuffle."),
  async execute(interaction) {
    const spotify = interaction.client.spotify;
    const status = await spotify.status(interaction.guildId, interaction.user.id);
    const enabled = !Boolean(status.playback?.shuffle_state);
    await spotify.shuffle(interaction.guildId, interaction.user.id, enabled);
    return interaction.reply(`🔀 Spotify shuffle **${enabled ? "ON" : "OFF"}**.`);
  }
};
