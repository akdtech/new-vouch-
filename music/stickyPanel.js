"use strict";

const { Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } = require("discord.js");

const PANEL_TITLE = "💀 DEATH Music 24/7";
const PANEL_MARKER = "DEATH_MUSIC_STICKY_PANEL";

const BUTTONS = [
  ["death_music_pause", "Pause", "⏸️", ButtonStyle.Secondary],
  ["death_music_resume", "Resume", "▶️", ButtonStyle.Success],
  ["death_music_skip", "Skip", "⏭️", ButtonStyle.Primary],
  ["death_music_stop", "Stop", "⏹️", ButtonStyle.Danger],
  ["death_music_shuffle", "Shuffle", "🔀", ButtonStyle.Secondary],
  ["death_music_queue", "Queue", "📜", ButtonStyle.Secondary],
  ["death_music_loop", "Loop", "🔁", ButtonStyle.Secondary],
  ["death_music_vol_down", "Vol -", "🔉", ButtonStyle.Secondary],
  ["death_music_vol_up", "Vol +", "🔊", ButtonStyle.Secondary],
  ["death_music_autoplay", "Autoplay", "🎵", ButtonStyle.Success],
  ["death_music_refresh", "Refresh", "🔄", ButtonStyle.Secondary]
];

function buildPanel() {
  const rows = [];
  for (let i = 0; i < BUTTONS.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const [id, label, emoji, style] of BUTTONS.slice(i, i + 5)) {
      row.addComponents(new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style));
    }
    rows.push(row);
  }

  const embed = new EmbedBuilder()
    .setTitle(PANEL_TITLE)
    .setDescription([
      "🎵 **24/7 Music Control**",
      "",
      "▶️ `/play <song>` starts music immediately.",
      "📜 Queue songs without interrupting playback.",
      "🎵 Autoplay keeps music running automatically.",
      "",
      "━━━━━━━━━━━━━━━━━━━━",
      "💀 **GMAO Gaming Community**",
      "Created by **DEATH**"
    ].join("\n"))
    .setFooter({ text: PANEL_MARKER });

  return { embeds: [embed], components: rows };
}

function isPanel(message) {
  return Boolean(message?.author?.bot && message.embeds?.some(e => e.title === PANEL_TITLE || e.footer?.text === PANEL_MARKER));
}

function getConfiguredChannelId() {
  return process.env.MUSIC_PANEL_CHANNEL_ID || process.env.MUSIC_TEXT_CHANNEL_ID || null;
}

function canSend(channel, member) {
  if (!channel?.isTextBased() || !member) return false;
  const perms = channel.permissionsFor(member);
  return Boolean(perms?.has(PermissionFlagsBits.ViewChannel) && perms?.has(PermissionFlagsBits.SendMessages));
}

async function chooseChannel(guild) {
  const configured = getConfiguredChannelId();
  const me = guild.members.me;

  if (configured) {
    const channel = guild.channels.cache.get(configured);
    if (channel?.isTextBased() && canSend(channel, me)) return channel;
  }

  /* Prefer the server's actual music text channel automatically. */
  const musicChannel = guild.channels.cache
    .filter(c => c.isTextBased() && !c.isThread())
    .sort((a, b) => a.position - b.position)
    .find(c => {
      const name = String(c.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      return (name === "music" || name === "music247" || name === "deathmusic" || name.includes("music")) && canSend(c, me);
    });

  if (musicChannel) return musicChannel;

  if (guild.systemChannel?.isTextBased() && canSend(guild.systemChannel, me)) return guild.systemChannel;

  return guild.channels.cache
    .filter(c => c.isTextBased() && !c.isThread())
    .sort((a, b) => a.position - b.position)
    .find(c => canSend(c, me)) || null;
}

async function createPanel(channel) {
  try {
    return await channel.send(buildPanel());
  } catch (error) {
    console.error("❌ Could not create sticky music panel:", error?.message || error);
    return null;
  }
}

async function ensurePanel(guild) {
  const channel = await chooseChannel(guild);
  if (!channel) {
    console.error(`❌ No writable music text channel found for the DEATH music panel in ${guild.name}.`);
    return null;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    const panels = messages.filter(isPanel);
    const existing = panels.first();

    for (const message of panels.values()) {
      if (message.id !== existing?.id) await message.delete().catch(() => {});
    }

    if (existing) {
      console.log(`📌 Music panel already exists in #${channel.name}.`);
      return existing;
    }

    const panel = await createPanel(channel);
    if (panel) console.log(`📌 Music panel created in #${channel.name}.`);
    return panel;
  } catch (error) {
    console.error("❌ Music panel setup failed:", error?.message || error);
    return null;
  }
}

function setupStickyMusicPanel(client, music) {
  if (!client) return;

  const knownChannels = new Set();
  const timers = new Map();

  const discover = async () => {
    console.log("📌 Sticky music panel system starting...");
    for (const guild of client.guilds.cache.values()) {
      const panel = await ensurePanel(guild);
      if (panel) knownChannels.add(panel.channelId);
    }
    console.log(`📌 Sticky music panel ready. Channels: ${knownChannels.size}`);
  };

  if (client.isReady()) discover().catch(() => {});
  else client.once(Events.ClientReady, () => discover().catch(() => {}));

  client.on(Events.MessageCreate, message => {
    if (!message.guild || message.author?.bot) return;
    if (!knownChannels.has(message.channelId)) return;

    clearTimeout(timers.get(message.channelId));
    timers.set(message.channelId, setTimeout(async () => {
      timers.delete(message.channelId);
      try {
        const messages = await message.channel.messages.fetch({ limit: 100 });
        for (const panel of messages.filter(isPanel).values()) await panel.delete().catch(() => {});
        await createPanel(message.channel);
      } catch (error) {
        console.warn("⚠️ Sticky panel refresh failed:", error?.message || error);
      }
    }, 1200));
  });

  client.on(Events.ChannelDelete, channel => {
    knownChannels.delete(channel?.id);
    clearTimeout(timers.get(channel?.id));
    timers.delete(channel?.id);
  });
}

module.exports = { setupStickyMusicPanel };
