const { SlashCommandBuilder,EmbedBuilder }=require("discord.js"); module.exports={data:new SlashCommandBuilder().setName("help").setDescription("Show all DEATH × GMAO features."),async execute(i){const e=new EmbedBuilder().setTitle("🤖 DEATH × GMAO").setDescription("**Built by DEATH for GMAO Gaming Community**").addFields(
{name:"🎵 Music",value:"`/join` `/play` `/pause` `/resume` `/skip` `/stop` `/queue` `/nowplaying` `/volume` `/loop` `/shuffle` `/autoplay` `/leave`"},
{name:"🛡️ Safety & Moderation",value:"`/warn` `/warnings` `/kick` `/ban` `/timeout` `/clear` + AutoMod"},
{name:"👥 Community",value:"Welcome system, suggestions, polls, announcements, server utilities"},
{name:"🎮 Gaming",value:"Profiles, XP, leaderboards and gaming utilities can be enabled"},
{name:"⚙️ Utility",value:"`/help` `/stats` `/serverinfo` `/userinfo` `/avatar` `/ping`"},
{name:"💀 Credits",value:"**Made by DEATH • Proudly serving GMAO**"}
).setFooter({text:"DEATH × GMAO • Music • Safety • Community • Gaming"});await i.reply({embeds:[e]});}};