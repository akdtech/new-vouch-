"use strict";

/*
 * DEATH Music 24/7
 * Sticky Music Panel
 *
 * Keeps the music control panel as the newest message
 * in the channel where the panel exists.
 *
 * IMPORTANT:
 * Discord has no real "fixed to bottom" message.
 * This implementation moves the panel to the bottom by
 * recreating it after a user sends a message.
 */

const {
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require("discord.js");

const PANEL_TITLE = "💀 DEATH Music 24/7";

const PANEL_MARKER = "DEATH_MUSIC_STICKY_PANEL";

const BUTTONS = [
  {
    id: "death_music_pause",
    label: "Pause",
    emoji: "⏸️",
    style: ButtonStyle.Secondary
  },
  {
    id: "death_music_resume",
    label: "Resume",
    emoji: "▶️",
    style: ButtonStyle.Success
  },
  {
    id: "death_music_skip",
    label: "Skip",
    emoji: "⏭️",
    style: ButtonStyle.Primary
  },
  {
    id: "death_music_stop",
    label: "Stop",
    emoji: "⏹️",
    style: ButtonStyle.Danger
  },
  {
    id: "death_music_shuffle",
    label: "Shuffle",
    emoji: "🔀",
    style: ButtonStyle.Secondary
  },
  {
    id: "death_music_queue",
    label: "Queue",
    emoji: "📜",
    style: ButtonStyle.Secondary
  },
  {
    id: "death_music_loop",
    label: "Loop",
    emoji: "🔁",
    style: ButtonStyle.Secondary
  },
  {
    id: "death_music_vol_down",
    label: "Vol -",
    emoji: "🔉",
    style: ButtonStyle.Secondary
  },
  {
    id: "death_music_vol_up",
    label: "Vol +",
    emoji: "🔊",
    style: ButtonStyle.Secondary
  },
  {
    id: "death_music_autoplay",
    label: "Autoplay",
    emoji: "🎵",
    style: ButtonStyle.Success
  },
  {
    id: "death_music_refresh",
    label: "Refresh",
    emoji: "🔄",
    style: ButtonStyle.Secondary
  }
];

function buildRows() {
  const rows = [];

  for (let i = 0; i < BUTTONS.length; i += 5) {
    const rowButtons = BUTTONS.slice(i, i + 5);

    const row = new ActionRowBuilder();

    for (const button of rowButtons) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(button.id)
          .setLabel(button.label)
          .setEmoji(button.emoji)
          .setStyle(button.style)
      );
    }

    rows.push(row);
  }

  return rows;
}

function buildPanelMessage() {
  const embed = new EmbedBuilder()
    .setTitle(PANEL_TITLE)
    .setDescription(
      [
        "🎵 **24/7 Music Control**",
        "",
        "Use the buttons below to control the music.",
        "",
        "▶️ **Play:** `/play <song>`",
        "📜 **Queue:** Add songs without interrupting the current track.",
        "🎵 **Autoplay:** Continues music automatically.",
        "",
        "━━━━━━━━━━━━━━━━━━━━",
        "",
        "💀 **GMAO Gaming Community**",
        "Created by **DEATH**"
      ].join("\n")
    )
    .setFooter({
      text: PANEL_MARKER
    });

  return {
    embeds: [embed],
    components: buildRows()
  };
}

function isPanelMessage(message) {
  if (!message) return false;
  if (!message.author?.bot) return false;

  if (message.embeds?.some(
    embed =>
      embed.title === PANEL_TITLE ||
      embed.footer?.text === PANEL_MARKER
  )) {
    return true;
  }

  return false;
}

function getPanelChannelId() {
  return process.env.MUSIC_PANEL_CHANNEL_ID || null;
}

async function findPanelInChannel(channel) {
  if (!channel?.isTextBased()) return null;

  try {
    const messages = await channel.messages.fetch({
      limit: 50
    });

    return messages.find(isPanelMessage) || null;
  } catch (error) {
    console.warn(
      "Sticky panel search failed:",
      error?.message || error
    );

    return null;
  }
}

async function deleteOldPanels(channel) {
  if (!channel?.isTextBased()) return 0;

  let deleted = 0;

  try {
    const messages = await channel.messages.fetch({
      limit: 100
    });

    const panels = messages.filter(isPanelMessage);

    for (const message of panels.values()) {
      try {
        await message.delete();
        deleted++;
      } catch {}
    }
  } catch (error) {
    console.warn(
      "Sticky panel cleanup failed:",
      error?.message || error
    );
  }

  return deleted;
}

async function createPanel(channel) {
  if (!channel?.isTextBased()) {
    return null;
  }

  try {
    const message = await channel.send(
      buildPanelMessage()
    );

    console.log(
      `📌 Sticky music panel created: ${channel.name}`
    );

    return message;
  } catch (error) {
    console.error(
      "❌ Could not create sticky music panel:",
      error?.message || error
    );

    return null;
  }
}

async function movePanelToBottom(channel) {
  if (!channel?.isTextBased()) return;

  try {
    /*
     * Delete every old panel first.
     * This prevents duplicate panels.
     */
    await deleteOldPanels(channel);

    /*
     * Wait a tiny amount so Discord finishes the delete
     * before we create the new panel.
     */
    await new Promise(resolve =>
      setTimeout(resolve, 500)
    );

    await createPanel(channel);
  } catch (error) {
    console.error(
      "❌ Sticky panel move failed:",
      error?.message || error
    );
  }
}

function setupStickyMusicPanel(client, music) {
  if (!client) {
    console.error(
      "❌ Sticky music panel: Discord client missing."
    );
    return;
  }

  /*
   * Per-channel timers.
   *
   * If 10 people send messages quickly, we don't recreate
   * the panel 10 times.
   */
  const timers = new Map();

  /*
   * Tracks the channel containing the panel.
   */
  const knownPanelChannels = new Set();

  function scheduleMove(channel) {
    if (!channel?.id) return;

    if (timers.has(channel.id)) {
      clearTimeout(timers.get(channel.id));
    }

    const timer = setTimeout(async () => {
      timers.delete(channel.id);

      try {
        await movePanelToBottom(channel);
      } catch (error) {
        console.error(
          "❌ Sticky panel scheduled move failed:",
          error?.message || error
        );
      }
    }, 1200);

    timers.set(channel.id, timer);
  }

  /*
   * Find existing panel after bot startup.
   *
   * If MUSIC_PANEL_CHANNEL_ID exists, use it directly.
   * Otherwise search the guild text channels for our panel.
   */
  async function discoverPanels() {
    console.log(
      "📌 Sticky music panel system starting..."
    );

    const configuredChannelId =
      getPanelChannelId();

    for (const guild of client.guilds.cache.values()) {
      try {
        /*
         * Explicit channel configured in Railway.
         */
        if (configuredChannelId) {
          const channel =
            guild.channels.cache.get(
              configuredChannelId
            );

          if (channel?.isTextBased()) {
            knownPanelChannels.add(channel.id);

            const panel =
              await findPanelInChannel(channel);

            if (!panel) {
              await createPanel(channel);
            } else {
              console.log(
                `📌 Existing sticky music panel found: ${channel.name}`
              );
            }

            continue;
          }
        }

        /*
         * No environment variable:
         * search cached text channels.
         */
        const textChannels =
          guild.channels.cache.filter(channel =>
            channel.isTextBased() &&
            !channel.isThread()
          );

        for (const channel of textChannels.values()) {
          const panel =
            await findPanelInChannel(channel);

          if (!panel) continue;

          knownPanelChannels.add(channel.id);

          /*
           * Remove any duplicate panel messages.
           */
          try {
            const messages =
              await channel.messages.fetch({
                limit: 100
              });

            const panels =
              messages.filter(isPanelMessage);

            let kept = false;

            for (const message of panels.values()) {
              if (!kept) {
                kept = true;
                continue;
              }

              await message.delete().catch(() => {});
            }
          } catch {}

          console.log(
            `📌 Sticky music panel found in: ${channel.name}`
          );

          break;
        }
      } catch (error) {
        console.warn(
          `Sticky panel discovery failed in ${guild.name}:`,
          error?.message || error
        );
      }
    }

    /*
     * If no panel was found and an explicit channel is configured,
     * create it.
     */
    if (configuredChannelId) {
      for (const guild of client.guilds.cache.values()) {
        const channel =
          guild.channels.cache.get(
            configuredChannelId
          );

        if (!channel?.isTextBased()) continue;

        const existing =
          await findPanelInChannel(channel);

        if (!existing) {
          knownPanelChannels.add(channel.id);
          await createPanel(channel);
        }
      }
    }

    console.log(
      `📌 Sticky music panel ready. Channels: ${knownPanelChannels.size}`
    );
  }

  /*
   * When the bot sends the panel, remember its channel.
   */
  client.on(
    Events.MessageCreate,
    async message => {
      if (!message?.guild) return;

      /*
       * Our own panel.
       */
      if (isPanelMessage(message)) {
        knownPanelChannels.add(message.channelId);
        return;
      }

      /*
       * Ignore all bot messages.
       */
      if (message.author?.bot) return;

      /*
       * If an explicit panel channel is configured,
       * only that channel gets sticky behavior.
       */
      const configuredChannelId =
        getPanelChannelId();

      if (
        configuredChannelId &&
        message.channelId !== configuredChannelId
      ) {
        return;
      }

      /*
       * If we already know this is a panel channel,
       * move the panel.
       */
      if (
        knownPanelChannels.has(
          message.channelId
        )
      ) {
        scheduleMove(message.channel);
        return;
      }

      /*
       * If we don't know the channel yet, check whether
       * a panel exists there.
       */
      try {
        const panel =
          await findPanelInChannel(
            message.channel
          );

        if (!panel) return;

        knownPanelChannels.add(
          message.channelId
        );

        scheduleMove(message.channel);
      } catch {}
    }
  );

  /*
   * Also listen for channel deletion.
   */
  client.on(
    Events.ChannelDelete,
    channel => {
      if (!channel?.id) return;

      knownPanelChannels.delete(channel.id);

      const timer = timers.get(channel.id);

      if (timer) {
        clearTimeout(timer);
        timers.delete(channel.id);
      }
    }
  );

  /*
   * Start discovery after Discord is ready.
   */
  if (client.isReady()) {
    discoverPanels().catch(error =>
      console.error(
        "❌ Sticky panel startup error:",
        error
      )
    );
  } else {
    client.once(
      Events.ClientReady,
      () => {
        discoverPanels().catch(error =>
          console.error(
            "❌ Sticky panel startup error:",
            error
          )
        );
      }
    );
  }

  return {
    movePanelToBottom,
    discoverPanels
  };
}

module.exports = {
  setupStickyMusicPanel,
  buildPanelMessage,
  isPanelMessage
};
