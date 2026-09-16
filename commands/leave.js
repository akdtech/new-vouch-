const { SlashCommandBuilder } = require("discord.js");
module.exports = { data:new SlashCommandBuilder().setName("leave").setDescription("Leave voice and stop music."), async execute(i,{music}) {
  await music.leave(i.guild.id); await i.reply("👋 Left the voice channel.");
}};