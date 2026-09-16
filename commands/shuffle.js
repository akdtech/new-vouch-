const { SlashCommandBuilder } = require("discord.js");
module.exports = {
  data: new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle the queued music."),
  async execute(interaction, { music }) {
    await music.shuffle(interaction.guildId);
    return interaction.reply("🔀 Queue shuffled.");
  }
};
