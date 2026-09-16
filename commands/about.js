const {SlashCommandBuilder,EmbedBuilder}=require("discord.js");
module.exports={data:new SlashCommandBuilder().setName("about").setDescription("About DEATH Music 24/7."),async execute(i){
 const e=new EmbedBuilder().setTitle("💀 DEATH Music 24/7")
 .setDescription("**Created by DEATH**\nBuilt for the **GMAO Gaming Community**.\n\n🎵 24/7 Music\n🛡️ Server Safety\n🎮 Gaming Community\n⚙️ Utilities")
 .addFields({name:"Creator",value:"**DEATH**",inline:true},{name:"Built for",value:"**GMAO**",inline:true},{name:"Purpose",value:"Keep GMAO connected with music, useful tools and reliable server automation."})
 .setFooter({text:"DEATH Music 24/7 • GMAO"}).setTimestamp();
 await i.reply({embeds:[e]});
}};