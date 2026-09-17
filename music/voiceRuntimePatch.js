"use strict";

/*
 * DEATH Music 24/7 runtime patch.
 *
 * Guarantees:
 *  - reliable YouTube/yt-dlp searching
 *  - manual /play gets priority over autoplay
 *  - autoplay resumes after the manual queue finishes
 *  - autoplay rotates Hindi, English TikTok/viral and top English music
 *  - no immediate repeats
 *  - track-transition recovery when Kazagumo exposes queue.current briefly
 */

const MusicManager = require("./MusicManager");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const originalEnsure247 = MusicManager.prototype.ensure247;
const originalSearch = MusicManager.prototype.search;
const originalAutoplayNext = MusicManager.prototype.autoplayNext;
const originalSetupEvents = MusicManager.prototype.setupEvents;
const originalPlay = MusicManager.prototype.play;

async function reliableSearch(manager, query, requester = null) {
  const clean = manager.cleanQuery(query);
  if (!clean) return null;

  if (manager.isYouTubeUrl(clean)) {
    return originalSearch.call(manager, clean, requester);
  }

  const identifiers = [
    `ytdlpsearch:${clean}`,
    `ytmsearch:${clean}`,
    `ytsearch:${clean}`
  ];

  for (const identifier of identifiers) {
    try {
      console.log(`🔎 Reliable music search: ${identifier}`);
      const result = await manager.kazagumo.search(identifier, { requester });
      if (result?.tracks?.length) {
        console.log(`✅ Reliable search found ${result.tracks.length} track(s) using ${identifier}`);
        return result;
      }
    } catch (error) {
      console.warn(`⚠️ Reliable search failed for ${identifier}:`, error?.message || error);
    }
  }

  console.error(`❌ No reliable music source returned tracks for "${clean}".`);
  return null;
}

async function waitForPreviousTrackToClear(player, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (!player?.queue?.current) return true;
    await sleep(250);
  }
  return !player?.queue?.current;
}

const AUTOPLAY_GROUPS = [
  {
    name: "Hindi Music",
    seeds: [
      "best Hindi songs 2026",
      "latest Hindi songs 2026",
      "Hindi hits playlist",
      "Bollywood hits 2026",
      "Hindi romantic songs",
      "Hindi party songs"
    ]
  },
  {
    name: "English TikTok Viral",
    seeds: [
      "TikTok viral songs 2026",
      "TikTok viral hits 2026",
      "viral English songs 2026",
      "TikTok trending songs",
      "viral pop songs 2026",
      "TikTok top songs"
    ]
  },
  {
    name: "Top English",
    seeds: [
      "top English songs 2026",
      "best English songs 2026",
      "top hits 2026",
      "global top songs 2026",
      "best pop hits 2026",
      "English chart hits 2026"
    ]
  }
];

function chooseAutoplaySeed(manager, guildId) {
  const state = manager.getState(guildId);
  const lastGroup = state.autoplayGroup || "";
  const available = AUTOPLAY_GROUPS.filter(group => group.name !== lastGroup);
  const group = available[Math.floor(Math.random() * available.length)] || AUTOPLAY_GROUPS[0];
  const seed = group.seeds[Math.floor(Math.random() * group.seeds.length)];
  return { group: group.name, seed };
}

async function reliableAutoplayNext(manager, guildId, player) {
  if (!player) return false;
  const state = manager.getState(guildId);

  if (!state.autoplay || manager.autoplayBusy.has(guildId)) return false;
  if (player.playing || player.paused) return false;

  if (player.queue?.current) {
    console.log(`⏳ Waiting for previous track to clear before autoplay | guild=${guildId}`);
    const cleared = await waitForPreviousTrackToClear(player, 8000);
    if (!cleared) return false;
  }

  if ((player.queue?.length || 0) > 0) {
    await player.play().catch(() => {});
    return true;
  }

  manager.autoplayBusy.add(guildId);

  try {
    const recent = manager.recentTracks.get(guildId) || [];

    for (let attempt = 1; attempt <= 10; attempt++) {
      const { group, seed } = chooseAutoplaySeed(manager, guildId);

      try {
        console.log(`🎵 Autoplay ${attempt}/10 [${group}]: "${seed}"`);
        const result = await reliableSearch(manager, seed, manager.client.user);
        if (!result?.tracks?.length) continue;

        const candidates = result.tracks.filter(track => {
          const id = manager.getTrackId(track);
          return id && !recent.includes(id);
        });
        const chosen = candidates[Math.floor(Math.random() * candidates.length)] || result.tracks[0];
        if (!chosen) continue;

        if (player.playing || player.paused || player.queue?.current) return true;
        if ((player.queue?.length || 0) > 0) {
          await player.play().catch(() => {});
          return true;
        }

        const id = manager.getTrackId(chosen);
        if (id) manager.recentTracks.set(guildId, [...recent, id].slice(-20));

        player.queue.add(chosen);
        await player.play();

        state.autoplayGroup = group;
        state.autoplayContext = {
          query: seed,
          group,
          artist: manager.getTrackAuthor(chosen),
          title: manager.getTrackTitle(chosen)
        };
        state.autoplayTrackId = id || null;
        state.autoplayGeneration = (state.autoplayGeneration || 0) + 1;

        console.log(`🎵 AUTOPLAY STARTED [${group}]: ${manager.getTrackTitle(chosen)} — ${manager.getTrackAuthor(chosen)}`);
        await manager.refreshPanel(guildId).catch(() => {});
        return true;
      } catch (error) {
        console.warn(`⚠️ Autoplay failed for "${seed}":`, error?.message || error);
      }
    }

    return false;
  } finally {
    manager.autoplayBusy.delete(guildId);
  }
}

/* Manual /play has priority over an autoplay track.
 * If autoplay is currently playing, remove it and start the requested song now.
 * If a manual song is already playing, normal queue behavior is preserved.
 */
MusicManager.prototype.play = async function(options) {
  const guildId = options?.guildId;
  const playerBefore = guildId ? this.getPlayer(guildId) : null;
  const state = guildId ? this.getState(guildId) : null;

  let interruptAutoplay = false;
  if (playerBefore && state?.autoplayTrackId) {
    const currentId = playerBefore.queue?.current ? this.getTrackId(playerBefore.queue.current) : null;
    interruptAutoplay = Boolean(currentId && currentId === state.autoplayTrackId);
  }

  if (interruptAutoplay) {
    console.log(`⏭️ Manual /play is taking priority over autoplay | guild=${guildId}`);
    state.autoplayTrackId = null;
    state.autoplayContext = null;

    try {
      if (playerBefore.queue && typeof playerBefore.queue.clear === "function") {
        playerBefore.queue.clear();
      }
    } catch (_) {}

    try {
      if (typeof playerBefore.stop === "function") await playerBefore.stop().catch(() => {});
    } catch (_) {}
  }

  const result = await originalPlay.call(this, options);

  if (state) {
    state.autoplay = true;
    state.autoplayTrackId = null;
    state.autoplayContext = null;
    state.lastManualPlayAt = Date.now();
  }

  return result;
};

MusicManager.prototype.autoplayNext = async function(guildId, player = this.getPlayer(guildId)) {
  return reliableAutoplayNext(this, guildId, player);
};

if (!MusicManager.prototype.__deathReliablePlaybackPatch) {
  MusicManager.prototype.__deathReliablePlaybackPatch = true;

  MusicManager.prototype.search = async function(query, requester = null) {
    return reliableSearch(this, query, requester);
  };

  MusicManager.prototype.setupEvents = function() {
    originalSetupEvents.call(this);

    if (this.__deathTransitionRecoveryInstalled) return;
    this.__deathTransitionRecoveryInstalled = true;
    this.__deathTransitionTimers = new Map();

    const scheduleRecovery = (player, reason) => {
      const guildId = player?.guildId;
      if (!guildId) return;

      const old = this.__deathTransitionTimers.get(guildId);
      if (old) clearTimeout(old);

      console.log(`🔁 Track transition recovery scheduled (${reason}) | guild=${guildId}`);

      const timer = setTimeout(async () => {
        this.__deathTransitionTimers.delete(guildId);
        const currentPlayer = this.getPlayer(guildId);
        const state = this.getState(guildId);
        if (!currentPlayer || !state.autoplay) return;
        if (currentPlayer.playing || currentPlayer.paused) return;

        try {
          const started = await this.autoplayNext(guildId, currentPlayer);
          console.log(`🔁 Track transition recovery result=${started} | guild=${guildId}`);
          if (!started && state.autoplay) {
            const retry = setTimeout(() => {
              this.__deathTransitionTimers.delete(guildId);
              const p = this.getPlayer(guildId);
              if (p && this.getState(guildId).autoplay && !p.playing && !p.paused) {
                this.autoplayNext(guildId, p).catch(error => console.warn("⚠️ Transition retry failed:", error?.message || error));
              }
            }, 2500);
            this.__deathTransitionTimers.set(guildId, retry);
          }
        } catch (error) {
          console.warn("⚠️ Track transition recovery failed:", error?.message || error);
        }
      }, 1500);

      this.__deathTransitionTimers.set(guildId, timer);
    };

    this.kazagumo.on("playerEnd", player => scheduleRecovery(player, "playerEnd"));
    this.kazagumo.on("playerException", player => scheduleRecovery(player, "playerException"));
    this.kazagumo.on("playerStuck", player => scheduleRecovery(player, "playerStuck"));
    this.kazagumo.on("playerEmpty", player => scheduleRecovery(player, "playerEmpty"));

    console.log("🛡️ DEATH track-transition recovery installed.");
  };

  MusicManager.prototype.ensure247 = async function(guildId = this.musicGuildId) {
    if (!guildId) return null;
    const state = this.getState(guildId);
    state.autoplay = true;
    const player = await originalEnsure247.call(this, guildId);
    if (!player) return null;
    console.log("🔊 24/7 voice player connected. Reliable autoplay rotation is active.");
    await this.refreshPanel(guildId).catch(() => {});
    return player;
  };
}

console.log("🛠️ DEATH autoplay rotation loaded: Hindi + English TikTok viral + Top English, with /play priority.");
