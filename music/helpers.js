function formatDuration(ms = 0) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${m}:${String(s).padStart(2,"0")}`;
}
function embed(title, description) {
  const { EmbedBuilder } = require("discord.js");
  return new EmbedBuilder().setTitle(title).setDescription(description).setFooter({text:"DEATH × GMAO"}).setTimestamp();
}
module.exports = { formatDuration, embed };
