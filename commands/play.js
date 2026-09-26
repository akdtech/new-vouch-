const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play music in the DEATH 24/7 Discord voice channel.")
    .addStringOption(option => option.setName("query").setDescription("Song title, artist, or direct audio URL").setRequired(true)),
  async execute(interaction, { music }) {
    if (!interaction.guildId) return interaction.reply({ content: "Server only.", ephemeral: true });
    const query = interaction.options.getString("query", true).trim();
    await interaction.deferReply();
    try {
      const result = await music.play({
        guildId: interaction.guildId,
        voiceId: interaction.member?.voice?.channelId || null,
        query,
        requester: interaction.user
      });
      const track = result.track;
      return interaction.editReply(
        `▶️ **Now playing in Discord VC**\n🎵 **${track.title}** — **${track.author}**\n🎧 **DEATH Music 24/7**\n♾️ Autoplay: same artist/genre`
      );
    } catch (error) {
      console.error("play error:", error);
      return interaction.editReply("❌ " + String(error?.message || error).replace(/\s+/g, " ").slice(0, 1800));
    }
  }
};
