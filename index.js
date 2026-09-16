const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  Events,
  REST,
  Routes,
  ActivityType
} = require("discord.js");

const http = require("http");
const fs = require("fs");
const path = require("path");

const { Kazagumo, Plugins } = require("kazagumo");
const { Connectors } = require("shoukaku");

const config = require("./config/config");
const MusicManager = require("./music/MusicManager");

// ============================================================
// CONFIG CHECK
// ============================================================

if (!config.token || !config.clientId) {
  console.error("❌ Missing DISCORD_TOKEN or CLIENT_ID.");
  process.exit(1);
}

// ============================================================
// DISCORD CLIENT
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],

  partials: [
    Partials.Channel,
    Partials.GuildMember,
    Partials.User
  ]
});

// ============================================================
// COMMANDS
// ============================================================

client.commands = new Collection();

const commandsPath = path.join(
  __dirname,
  "commands"
);

if (!fs.existsSync(commandsPath)) {
  console.error("❌ Commands folder not found.");
  process.exit(1);
}

const commandFiles = fs
  .readdirSync(commandsPath)
  .filter(
    file =>
      file.endsWith(".js") &&
      file !== "index.js"
  );

const duplicateCommands = new Map();

for (const file of commandFiles) {
  try {
    const command = require(
      path.join(commandsPath, file)
    );

    if (
      command.data &&
      command.execute
    ) {
      const name =
        command.data.name;

      if (
        client.commands.has(name)
      ) {
        duplicateCommands.set(
          name,
          [
            ...(duplicateCommands.get(
              name
            ) || []),
            file
          ]
        );

        console.error(
          `❌ Duplicate command detected: /${name} (${file})`
        );

        continue;
      }

      client.commands.set(
        name,
        command
      );
    } else {
      console.warn(
        `⚠️ Invalid command skipped: ${file}`
      );
    }
  } catch (error) {
    console.error(
      `❌ Failed loading ${file}:`,
      error
    );
  }
}

if (
  duplicateCommands.size
) {
  console.error(
    `❌ ${duplicateCommands.size} duplicate command name(s) found.`
  );
}

console.log(
  `📦 Loaded ${client.commands.size} commands.`
);

// ============================================================
// LAVALINK
// ============================================================

const lavalinkHost =
  process.env.LAVALINK_HOST ||
  config.lavalink?.host ||
  "reliable-miracle.railway.internal";

const lavalinkPort =
  Number(
    process.env.LAVALINK_PORT ||
    config.lavalink?.port ||
    2333
  );

const lavalinkName =
  process.env.LAVALINK_NAME ||
  config.lavalink?.name ||
  "main";

const lavalinkPassword =
  process.env.LAVALINK_PASSWORD ||
  config.lavalink?.password;

if (!lavalinkPassword) {
  console.error(
    "❌ Missing LAVALINK_PASSWORD."
  );

  console.error(
    "Set LAVALINK_PASSWORD in Railway Variables."
  );

  process.exit(1);
}

const lavalinkSecure =
  String(
    process.env.LAVALINK_SECURE ??
    config.lavalink?.secure ??
    "false"
  ).toLowerCase() === "true";

const nodes = [
  {
    name: lavalinkName,

    url:
      `${lavalinkHost}:${lavalinkPort}`,

    auth:
      lavalinkPassword,

    secure:
      lavalinkSecure
  }
];

console.log("");
console.log("🎵 Lavalink:");
console.log(
  `   ${lavalinkName} → ${lavalinkHost}:${lavalinkPort}`
);
console.log(
  `   Secure: ${lavalinkSecure}`
);
console.log("");

// ============================================================
// KAZAGUMO
// ============================================================

const kazagumo =
  new Kazagumo(
    {
      defaultSearchEngine:
        "youtube",

      plugins: [
        new Plugins.PlayerMoved(
          client
        )
      ]
    },

    new Connectors.DiscordJS(
      client
    ),

    nodes,

    {
      reconnectTries: 1000,

      reconnectInterval: 5,

      restTimeout: 60000,

      resume: true,

      resumeTimeout: 60,

      resumeByLibrary: true,

      moveOnDisconnect: true,

      voiceConnectionTimeout: 30
    }
  );

console.log(
  "🧩 Kazagumo initialized."
);

// ============================================================
// MUSIC MANAGER
// ============================================================

const music =
  new MusicManager(
    kazagumo,
    client,
    config
  );

client.music = music;
client.kazagumo = kazagumo;

// ============================================================
// STICKY MUSIC PANEL
// ============================================================

try {
  const {
    setupStickyMusicPanel
  } = require(
    "./music/stickyPanel"
  );

  setupStickyMusicPanel(
    client,
    music
  );

  console.log(
    "📌 Sticky music panel enabled."
  );
} catch (error) {
  console.error(
    "❌ Failed to load sticky music panel:",
    error
  );
}

// ============================================================
// LAVALINK EVENTS
// ============================================================

kazagumo.shoukaku.on(
  "ready",
  name => {
    console.log(
      `🟢 Lavalink node READY: ${name}`
    );

    /*
     * Make sure the permanent
     * music channel is connected.
     */
    music
      .ensure247(
        config.guildId
      )
      .catch(error => {
        console.error(
          "❌ Music startup after Lavalink ready failed:",
          error
        );
      });
  }
);

kazagumo.shoukaku.on(
  "error",
  (
    name,
    error
  ) => {
    console.error(
      `🔴 Lavalink ${name} error:`,
      error?.message ||
        error
    );
  }
);

kazagumo.shoukaku.on(
  "close",
  (
    name,
    code,
    reason
  ) => {
    console.warn(
      `🟠 Lavalink ${name} closed: code=${code || "unknown"} reason=${reason || "none"}`
    );
  }
);

kazagumo.shoukaku.on(
  "disconnect",
  (
    name,
    count
  ) => {
    console.warn(
      `🟠 Lavalink ${name} disconnected. players=${count || 0}`
    );
  }
);

// ============================================================
// DISCORD READY
// ============================================================

client.once(
  Events.ClientReady,
  async readyClient => {
    console.log("");
    console.log(
      "════════════════════════════════"
    );
    console.log(
      `✅ ${readyClient.user.tag} is ONLINE`
    );
    console.log(
      "🎵 DEATH Music 24/7"
    );
    console.log(
      "🎮 GMAO Gaming Community"
    );
    console.log(
      "════════════════════════════════"
    );
    console.log("");

    readyClient.user.setPresence({
      activities: [
        {
          name:
            "GMAO • DEATH Music 24/7",
          type:
            ActivityType.Listening
        }
      ],

      status: "online"
    });

    // ========================================================
    // SLASH COMMAND REGISTRATION
    // ========================================================

    try {
      const commands =
        [
          ...client.commands.values()
        ].map(command =>
          command.data.toJSON()
        );

      const rest =
        new REST({
          version: "10"
        }).setToken(
          config.token
        );

      /*
       * Clear old global commands.
       * This prevents duplicate commands.
       */
      await rest.put(
        Routes.applicationCommands(
          config.clientId
        ),
        {
          body: []
        }
      );

      console.log(
        "🧹 Old global slash commands removed."
      );

      /*
       * Register one clean GMAO
       * guild command set.
       */
      if (config.guildId) {
        await rest.put(
          Routes.applicationGuildCommands(
            config.clientId,
            config.guildId
          ),
          {
            body: commands
          }
        );

        console.log(
          `✅ Registered ${commands.length} unique GMAO guild commands.`
        );
      } else {
        await rest.put(
          Routes.applicationCommands(
            config.clientId
          ),
          {
            body: commands
          }
        );

        console.log(
          `✅ Registered ${commands.length} global commands.`
        );
      }
    } catch (error) {
      console.error(
        "❌ Slash command registration failed:",
        error
      );
    }

    // ========================================================
    // START MUSIC
    // ========================================================

    try {
      music.startRecoveryLoop();

      await music.ensure247(
        config.guildId
      );

      console.log(
        "♾️ Permanent GMAO Music voice connection requested."
      );
    } catch (error) {
      console.error(
        "❌ 24/7 music startup failed:",
        error
      );
    }
  }
);

// ============================================================
// INTERACTIONS
// ============================================================

client.on(
  Events.InteractionCreate,
  async interaction => {

    // ========================================================
    // SLASH COMMANDS
    // ========================================================

    if (
      interaction.isChatInputCommand()
    ) {
      const command =
        client.commands.get(
          interaction.commandName
        );

      if (!command) {
        return;
      }

      try {
        await command.execute(
          interaction,
          {
            client,
            music,
            kazagumo,
            config
          }
        );
      } catch (error) {
        console.error(
          `❌ /${interaction.commandName} error:`,
          error
        );

        const response = {
          content:
            `❌ ${
              error?.message ||
              "Something went wrong while running this command."
            }`,

          ephemeral: true
        };

        try {
          if (
            interaction.replied ||
            interaction.deferred
          ) {
            await interaction.editReply(
              response
            );
          } else {
            await interaction.reply(
              response
            );
          }
        } catch {}
      }

      return;
    }

    // ========================================================
    // MUSIC PANEL BUTTONS
    // ========================================================

    if (
      interaction.isButton() &&
      interaction.customId.startsWith(
        "death_music_"
      )
    ) {
      const guildId =
        interaction.guildId;

      if (!guildId) {
        return interaction.reply({
          content:
            "❌ Server only.",

          ephemeral: true
        });
      }

      try {
        switch (
          interaction.customId
        ) {

          // --------------------------------------------------
          // PAUSE
          // --------------------------------------------------

          case "death_music_pause":
            await music.pause(
              guildId
            );
            break;

          // --------------------------------------------------
          // RESUME
          // --------------------------------------------------

          case "death_music_resume":
            await music.resume(
              guildId
            );
            break;

          // --------------------------------------------------
          // SKIP
          // --------------------------------------------------

          case "death_music_skip":
            await music.skip(
              guildId
            );
            break;

          // --------------------------------------------------
          // STOP
          // --------------------------------------------------

          case "death_music_stop":
            await music.stop(
              guildId
            );
            break;

          // --------------------------------------------------
          // SHUFFLE
          // --------------------------------------------------

          case "death_music_shuffle":
            await music.shuffle(
              guildId
            );
            break;

          // --------------------------------------------------
          // LOOP
          // --------------------------------------------------

          case "death_music_loop": {
            const state =
              music.getState(
                guildId
              );

            const next =
              state.loop === "none"
                ? "track"
                : state.loop === "track"
                  ? "queue"
                  : "none";

            await music.setLoop(
              guildId,
              next
            );

            break;
          }

          // --------------------------------------------------
          // VOLUME DOWN
          // --------------------------------------------------

          case "death_music_vol_down": {
            const player =
              music.getPlayer(
                guildId
              );

            const currentVolume =
              Number(
                player?.volume || 70
              );

            await music.setVolume(
              guildId,
              Math.max(
                1,
                currentVolume - 10
              )
            );

            break;
          }

          // --------------------------------------------------
          // VOLUME UP
          // --------------------------------------------------

          case "death_music_vol_up": {
            const player =
              music.getPlayer(
                guildId
              );

            const currentVolume =
              Number(
                player?.volume || 70
              );

            await music.setVolume(
              guildId,
              Math.min(
                100,
                currentVolume + 10
              )
            );

            break;
          }

          // --------------------------------------------------
          // AUTOPLAY
          // --------------------------------------------------

          case "death_music_autoplay": {
            const state =
              music.getState(
                guildId
              );

            state.autoplay =
              !state.autoplay;

            state.autoplayGeneration =
              (
                state.autoplayGeneration ||
                0
              ) + 1;

            if (
              state.autoplay
            ) {
              await music.autoplayNext(
                guildId
              );
            }

            break;
          }

          // --------------------------------------------------
          // QUEUE
          // --------------------------------------------------

          case "death_music_queue": {
            const queue =
              music
                .getQueue(
                  guildId
                )
                .slice(0, 15);

            const text =
              queue.length
                ? queue
                    .map(
                      (
                        track,
                        index
                      ) =>
                        `${index + 1}. ${music.getTrackTitle(track)}`
                    )
                    .join("\n")
                : "Nothing queued.";

            return interaction.reply({
              content:
                `📜 **DEATH Music Queue**\n${text}`,

              ephemeral: true
            });
          }

          // --------------------------------------------------
          // REFRESH
          // --------------------------------------------------

          case "death_music_refresh":
            await music.refreshPanel(
              guildId
            );

            return interaction.reply({
              content:
                "🔄 Music panel refreshed.",

              ephemeral: true
            });
        }

        await music.refreshPanel(
          guildId
        );

        return interaction.reply({
          content:
            "✅ Music control updated.",

          ephemeral: true
        });

      } catch (error) {

        console.error(
          "❌ Music button error:",
          error
        );

        try {
          return interaction.reply({
            content:
              `❌ ${
                error?.message ||
                "Music control failed."
              }`,

            ephemeral: true
          });
        } catch {}
      }
    }
  }
);

// ============================================================
// VOICE STATE
// ============================================================

client.on(
  Events.VoiceStateUpdate,
  async (
    oldState,
    newState
  ) => {
    try {
      if (
        !newState.guild
      ) {
        return;
      }

      if (
        newState.member?.user?.bot
      ) {
        return;
      }

      if (
        typeof music.handleVoiceStateUpdate ===
        "function"
      ) {
        await music.handleVoiceStateUpdate(
          oldState,
          newState
        );
      }

    } catch (error) {
      console.error(
        "❌ Voice state error:",
        error
      );
    }
  }
);

// ============================================================
// MEMBER JOIN
// ============================================================

client.on(
  Events.GuildMemberAdd,
  async member => {
    try {
      if (
        typeof music.handleMemberJoin ===
        "function"
      ) {
        await music.handleMemberJoin(
          member
        );
      }
    } catch (error) {
      console.error(
        "❌ Member join error:",
        error
      );
    }
  }
);

// ============================================================
// HEALTH SERVER
// ============================================================

const healthPort =
  Number(
    process.env.PORT || 3000
  );

const healthServer =
  http.createServer(
    (req, res) => {
      res.writeHead(
        200,
        {
          "Content-Type":
            "application/json"
        }
      );

      res.end(
        JSON.stringify({
          status:
            "online",

          bot:
            client.user
              ? client.user.tag
              : "starting",

          lavalink:
            lavalinkName,

          uptime:
            process.uptime(),

          timestamp:
            new Date().toISOString()
        })
      );
    }
  );

healthServer.listen(
  healthPort,
  "0.0.0.0",
  () => {
    console.log(
      `🌐 Health server listening on port ${healthPort}`
    );
  }
);

// ============================================================
// ERRORS
// ============================================================

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "❌ UNHANDLED REJECTION:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "❌ UNCAUGHT EXCEPTION:",
      error
    );
  }
);

// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown(
  signal
) {
  console.log(
    `🛑 ${signal} received.`
  );

  try {
    if (
      music &&
      typeof music.shutdown ===
        "function"
    ) {
      await music.shutdown();
    }
  } catch {}

  try {
    healthServer.close();
  } catch {}

  try {
    client.destroy();
  } catch {}

  process.exit(0);
}

process.on(
  "SIGINT",
  () =>
    shutdown("SIGINT")
);

process.on(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
);

// ============================================================
// LOGIN
// ============================================================

console.log(
  "🔐 Logging into Discord..."
);

client
  .login(config.token)
  .then(() => {
    console.log(
      "🔐 Discord login successful."
    );
  })
  .catch(error => {
    console.error(
      "❌ Discord login failed:",
      error
    );

    process.exit(1);
  });
