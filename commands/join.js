const { SlashCommandBuilder } = require("discord.js");
module.exports = { data: new SlashCommandBuilder().setName("join").setDescription("Join your voice channel."), async execute(i,{music}) {
  if (!i.member.voice.channel) return i.reply({content:"❌ Join a voice channel first.",ephemeral:true});
  await music.join(i.guild,i.member.voice.channel); await i.reply("🎵 **DEATH × GMAO** joined the voice channel.");
}};