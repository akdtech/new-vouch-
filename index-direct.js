const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  Events,
  REST,
  Routes,
  ActivityType,
  PermissionFlagsBits
} = require("discord.js");
const http = require("http");
const fs = require("fs");
const path = require("path");

const config = require("./config/config");
const MusicManager = require("./music/DirectMusicManager");
// Load the unlimited related-autoplay queue after all preload patches so it owns the final autoplay transition.
require("./music/directUnlimitedAutoplayPatch");
const SpotifyController = require("./spotify/SpotifyController");

console.log("🧹 DEATH Music boot: Discord Voice 24/7 mode.");

if (!config.token || !config.clientId) {
  console.error("❌ Missing DISCORD_TOKEN or CLIENT_ID.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.GuildMember, Partials.User]
});

client.commands = new Collection();
const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs.existsSync(commandsPath)
  ? fs.readdirSync(commandsPath).filter(file => file.endsWith(".js") && file !== "index.js")
  : [];

for (const file of commandFiles) {
  try {
    const command = require(path.join(commandsPath, file));
    if (command.data && command.execute) {
      if (client.commands.has(command.data.name)) console.error(`❌ Duplicate command: /${command.data.name}`);
      else client.commands.set(command.data.name, command);
    }
  } catch (error) {
    console.error(`❌ Failed loading ${file}:`, error);
  }
}
console.log(`📦 Loaded ${client.commands.size} commands.`);

const music = new MusicManager(client, config);
client.music = music;
const spotify = new SpotifyController({ callbackUrl: process.env.SPOTIFY_REDIRECT_URI || "" });
client.spotify = spotify;
client.kazagumo = null;

function resolveMusicPanelChannel(guildId, preferredChannelId = null) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;

  const botMember = guild.members.me;
  const candidates = [];
  if (music.musicTextChannelId) candidates.push(guild.channels.cache.get(music.musicTextChannelId));
  if (preferredChannelId) candidates.push(guild.channels.cache.get(preferredChannelId));

  for (const channel of guild.channels.cache.values()) {
    if (!channel?.isTextBased?.()) continue;
    if (/(^|[-_\s])(music|music-247|death-music|death-music-247|247)([-_\s]|$)/i.test(String(channel.name || "")) || /music|24\/7|247/i.test(String(channel.name || ""))) {
      candidates.push(channel);
    }
  }

  const seen = new Set();
  for (const channel of candidates) {
    if (!channel || seen.has(channel.id)) continue;
    seen.add(channel.id);
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    if (!permissions) continue;
    if (!permissions.has(PermissionFlagsBits.ViewChannel)) continue;
    if (!permissions.has(PermissionFlagsBits.SendMessages)) continue;
    if (!permissions.has(PermissionFlagsBits.EmbedLinks)) continue;
    if (!permissions.has(PermissionFlagsBits.ReadMessageHistory)) continue;
    music.musicTextChannelId = channel.id;
    return channel;
  }

  return null;
}

client.once(Events.ClientReady, async readyClient => {
  console.log("");
  console.log("════════════════════════════════");
  console.log(`✅ ${readyClient.user.tag} is ONLINE`);
  console.log("🎧 DEATH Music — Discord Voice 24/7");
  console.log("🎮 GMAO Gaming Community");
  console.log("════════════════════════════════");

  readyClient.user.setPresence({
    activities: [{ name: "GMAO • DEATH Music 24/7", type: ActivityType.Listening }],
    status: "online"
  });

  try {
    const legacyMusicCommands = new Set(["queue"]);
    const commands = [...client.commands.values()]
      .filter(command => !legacyMusicCommands.has(command.data.name))
      .map(command => command.data.toJSON());
    const rest = new REST({ version: "10" }).setToken(config.token);
    await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
    if (config.guildId) {
      await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
      console.log(`✅ Registered ${commands.length} GMAO guild commands.`);
    } else {
      await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
      console.log(`✅ Registered ${commands.length} global commands.`);
    }
  } catch (error) {
    console.error("❌ Slash command registration failed:", error?.message || error);
  }

  try {
    const panelChannel = resolveMusicPanelChannel(config.guildId);
    if (panelChannel) {
      console.log(`🎨 Music panel channel resolved: #${panelChannel.name} (${panelChannel.id})`);
    } else {
      console.warn("⚠️ No writable music text channel found yet; ensure247 will resolve it again.");
    }

    // The compatibility patch intentionally disables the manager's old ready
    // listener, so startup is owned here: join the permanent VC, subscribe the
    // audio player, create the panel, and start autoplay.
    if (config.guildId) {
      await music.ensure247(config.guildId);
      music.startRecoveryLoop();
      console.log(`♾️ 24/7 voice startup complete for guild ${config.guildId}.`);
    }

    console.log("🎧 Discord voice music engine active.");
    console.log("♾️ 24/7 voice recovery + same-artist/genre autoplay active.");
  } catch (error) {
    console.error("❌ 24/7 music startup failed:", error?.message || error);
  }
});

// Sticky music panel: after a user sends a message in the music channel,
// recreate the single control panel at the very bottom. Editing a Discord
// message does not move it, so the panel must be recreated to stay last.
let stickyPanelTimer = null;
let stickyPanelBusy = false;
let stickyPanelPending = false;

client.on(Events.MessageCreate, message => {
  if (!message.guildId || message.author?.bot) return;
  if (message.guildId !== config.guildId) return;
  if (!music.musicTextChannelId || message.channelId !== music.musicTextChannelId) return;

  stickyPanelPending = true;
  clearTimeout(stickyPanelTimer);
  stickyPanelTimer = setTimeout(async () => {
    if (stickyPanelBusy) return;
    stickyPanelBusy = true;
    try {
      while (stickyPanelPending) {
        stickyPanelPending = false;
        const state = music.getState(message.guildId);
        if (!state.panelMessageId) await music.ensurePanel(message.guildId).catch(() => {});
        else await music.movePanelToBottom(message.guildId);
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    } catch (error) {
      console.warn("⚠️ Sticky music panel move failed:", error?.message || error);
    } finally {
      stickyPanelBusy = false;
      if (stickyPanelPending) {
        clearTimeout(stickyPanelTimer);
        stickyPanelTimer = setTimeout(() => {
          stickyPanelBusy = false;
          stickyPanelPending = true;
          const state = music.getState(message.guildId);
          music.movePanelToBottom(message.guildId).catch(error => console.warn("⚠️ Sticky music panel retry failed:", error?.message || error));
        }, 50);
      }
    }
  }, 250);
});
const MUSIC_ACTION_JOKES = [
  "🎧 **{user}** just used **{action}** — the DJ has been notified. Please remain calm. 😂",
  "🤣 **{user}** hit **{action}** — bro really said 'let DEATH handle the music.'",
  "🎵 **{user}** used **{action}** — certified DJ behavior detected.",
  "🚨 **{user}** used **{action}** — the music department is now pretending this was planned.",
  "🫡 **{user}** called **{action}** — DEATH Music is on the case. No refunds.",
  "🔥 **{user}** used **{action}** — somebody give this person the aux already.",
  "💀 **{user}** pressed **{action}** — the song has been summoned.",
  "🎶 **{user}** used **{action}** — Spotify lawyers have been notified. (Probably.)"
];

async function announceMusicAction(interaction, action) {
  if (!interaction?.guildId) return;

  let channel = null;
  if (interaction.channel?.isTextBased?.() && typeof interaction.channel.send === "function") {
    channel = interaction.channel;
  } else {
    channel = resolveMusicPanelChannel(interaction.guildId, interaction.channelId);
  }

  if (!channel || typeof channel.send !== "function") return;

  const joke = MUSIC_ACTION_JOKES[Math.floor(Math.random() * MUSIC_ACTION_JOKES.length)]
    .replace("{user}", `<@${interaction.user.id}>`)
    .replace("{action}", action);

  try {
    await channel.send({
      content: joke,
      allowedMentions: { users: [] }
    });
  } catch (error) {
    console.warn("⚠️ Music action announcement failed:", error?.message || error);
  }
}

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    if (interaction.guildId === config.guildId) {
      resolveMusicPanelChannel(interaction.guildId, interaction.channelId);
    }

    // Visible activity log: show who used each music slash command without
    // changing the command actual behavior or response.
    announceMusicAction(interaction, "/" + interaction.commandName).catch(() => {});

    try {
      await command.execute(interaction, { client, music, config, kazagumo: null });
    } catch (error) {
      console.error(`❌ /${interaction.commandName} error:`, error);
      const response = {
        content: `❌ ${error?.message || "Something went wrong while running this command."}`,
        ephemeral: true
      };
      try {
        if (interaction.replied || interaction.deferred) await interaction.editReply(response);
        else await interaction.reply(response);
      } catch (replyError) {
        if (replyError?.code !== 10008) console.warn("⚠️ Command error response failed:", replyError?.message || replyError);
      }
    } finally {
      // Slash commands do not fire MessageCreate, so explicitly move the
      // control panel back to the absolute bottom after every command.
      if (interaction.guildId === config.guildId && music.musicTextChannelId) {
        const state = music.getState(interaction.guildId);
        if (state.panelMessageId) {
          await music.movePanelToBottom(interaction.guildId).catch(error =>
            console.warn("⚠️ Command sticky panel move failed:", error?.message || error)
          );
        } else {
          await music.ensurePanel(interaction.guildId).catch(() => {});
        }
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("death_music_")) {
    const guildId = interaction.guildId;
    if (!guildId) return interaction.reply({ content: "❌ Server only.", ephemeral: true });

    const isQueue = interaction.customId === "death_music_queue";
    try {
      if (isQueue) await interaction.deferReply({ ephemeral: true });
      else await interaction.deferUpdate();
    } catch (error) {
      if (error?.code !== 10008) console.warn("⚠️ Music button acknowledgement failed:", error?.message || error);
      return;
    }

    // Also log panel controls so we can see who pressed Skip/Pause/Play/etc.
    const buttonActionNames = {
      death_music_pause: "Pause",
      death_music_resume: "Play",
      death_music_skip: "Skip",
      death_music_stop: "Stop",
      death_music_shuffle: "Shuffle",
      death_music_loop: "Loop",
      death_music_vol_down: "Volume −",
      death_music_vol_up: "Volume +",
      death_music_autoplay: "Autoplay",
      death_music_queue: "Queue",
      death_music_refresh: "Refresh"
    };
    announceMusicAction(
      interaction,
      buttonActionNames[interaction.customId] || interaction.customId.replace(/^death_music_/, "")
    ).catch(() => {});

    try {
      switch (interaction.customId) {
        case "death_music_pause":
          await music.pause(guildId);
          break;
        case "death_music_resume":
          await music.resume(guildId);
          break;
        case "death_music_skip":
          await music.skip(guildId);
          break;
        case "death_music_stop":
          await music.stop(guildId);
          break;
        case "death_music_shuffle":
          await music.shuffle(guildId);
          break;
        case "death_music_loop": {
          const state = music.getState(guildId);
          const next = state.loop === "none" ? "track" : state.loop === "track" ? "queue" : "none";
          await music.setLoop(guildId, next);
          break;
        }
        case "death_music_vol_down": {
          const state = music.getState(guildId);
          await music.setVolume(guildId, Math.max(1, Number(state.volume || 70) - 10));
          break;
        }
        case "death_music_vol_up": {
          const state = music.getState(guildId);
          await music.setVolume(guildId, Math.min(100, Number(state.volume || 70) + 10));
          break;
        }
        case "death_music_autoplay": {
          const state = music.getState(guildId);
          state.autoplay = !state.autoplay;
          state.autoplayGeneration = (state.autoplayGeneration || 0) + 1;
          if (state.autoplay) await music.autoplayNext(guildId).catch(() => {});
          break;
        }
        case "death_music_queue": {
          const tracks = music.getQueue(guildId);
          return await interaction.editReply({
            content: tracks.length
              ? "🎵 **DEATH Music Queue**\n" + tracks.slice(0, 15).map((t, n) => `${n + 1}. ${t.title} — ${t.author}`).join("\n")
              : "🎵 Nothing is queued."
          });
        }
        case "death_music_refresh":
          await music.ensurePanel(guildId);
          break;
      }

      await music.refreshPanel(guildId).catch(() => {});
      if (isQueue) return;
      // Button interactions also do not create MessageCreate events.
      // Recreate the panel after every control action so it remains last.
      if (guildId === config.guildId && music.musicTextChannelId) {
        await music.movePanelToBottom(guildId).catch(error =>
          console.warn("⚠️ Button sticky panel move failed:", error?.message || error)
        );
      }
    } catch (error) {
      console.error("❌ Music button error:", error);
      await music.refreshPanel(guildId).catch(() => {});
      return;
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try { await music.handleVoiceStateUpdate(oldState, newState); }
  catch (error) { console.error("❌ Voice state error:", error); }
});

client.on(Events.GuildMemberAdd, async member => {
  try { await music.handleMemberJoin(member); } catch {}
});

const healthPort = Number(process.env.PORT || 3000);
const healthServer = http.createServer(async (req, res) => {
  if ((req.url || "").startsWith("/spotify/callback")) {
    try {
      const u = new URL(req.url, "http://localhost");
      await client.spotify.callback(u.searchParams.get("code"), u.searchParams.get("state"));
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Spotify callback available for the optional Spotify integration. Use /play for Discord voice music.");
    } catch (error) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Spotify connection failed: " + String(error?.message || error));
    }
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "online",
    bot: client.user ? client.user.tag : "starting",
    musicEngine: "discord-voice-24-7",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  }));
});
healthServer.listen(healthPort, "0.0.0.0", () => console.log(`🌐 Health server listening on port ${healthPort}`));

process.on("unhandledRejection", error => console.error("❌ UNHANDLED REJECTION:", error));
process.on("uncaughtException", error => console.error("❌ UNCAUGHT EXCEPTION:", error));

async function shutdown(signal) {
  console.log(`🛑 ${signal} received.`);
  try { await music.shutdown(); } catch {}
  try { healthServer.close(); } catch {}
  try { client.destroy(); } catch {}
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log("🔐 Logging into Discord...");
client.login(config.token)
  .then(() => console.log("🔐 Discord login successful."))
  .catch(error => {
    console.error("❌ Discord login failed:", error);
    process.exit(1);
  });
