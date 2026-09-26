const { SlashCommandBuilder } = require("discord.js");
module.exports = {
  data: new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle the current music queue."),
  async execute(interaction, { music }) {
    await music.shuffle(interaction.guildId);
    return interaction.reply("🔀 Music queue shuffled.");
  }
};
