const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "moderation-settings.json");

let data = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  }
} catch {
  data = {};
}

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.warn("Could not save moderation settings:", error?.message || error);
  }
}

function getGuild(guildId) {
  if (!data[guildId]) data[guildId] = { modRoleId: null, warnings: {} };
  if (!data[guildId].warnings) data[guildId].warnings = {};
  return data[guildId];
}

function setModRole(guildId, roleId) {
  getGuild(guildId).modRoleId = roleId;
  save();
}

function clearModRole(guildId) {
  getGuild(guildId).modRoleId = null;
  save();
}

function getModRole(guildId) {
  return getGuild(guildId).modRoleId || null;
}

function canModerate(interaction) {
  if (interaction.memberPermissions?.has("Administrator")) return true;
  const roleId = getModRole(interaction.guildId);
  if (!roleId) return false;
  return Boolean(interaction.member?.roles?.cache?.has(roleId));
}

function key(guildId, userId) {
  return `${guildId}:${userId}`;
}

function add(guildId, userId, reason, by) {
  const guild = getGuild(guildId);
  const k = key(guildId, userId);
  const list = guild.warnings[k] || [];
  list.push({ reason, at: Date.now(), by });
  guild.warnings[k] = list;
  save();
  return list;
}

function get(guildId, userId) {
  return getGuild(guildId).warnings[key(guildId, userId)] || [];
}

module.exports = {
  setModRole,
  clearModRole,
  getModRole,
  canModerate,
  add,
  get
};
