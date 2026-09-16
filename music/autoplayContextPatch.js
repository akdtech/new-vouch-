"use strict";

/*
 * DEATH Music 24/7 runtime patch.
 *
 * Fixes two problems without replacing the large MusicManager file:
 * 1) autoplay must follow the user's selected artist/search instead of
 *    falling back to unrelated YouTube videos;
 * 2) startup can call ensure247 from several places at the same time,
 *    which creates duplicate Kazagumo voice connections and can cause
 *    "Connection exist but player not found" / 30-second voice failures.
 */
const Module = require("module");
const originalLoad = Module._load;

let patched = false;

function clean(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeArtist(value) {
  return clean(value)
    .replace(/\s*-\s*topic$/i, "")
    .replace(/\s*\|\s*topic$/i, "")
    .replace(/\s*official$/i, "")
    .replace(/\s*vevo$/i, "")
    .trim();
}

function isGenericArtist(artist) {
  const value = normalizeArtist(artist).toLowerCase();
  return !value || [
    "unknown artist",
    "unknown",
    "various artists",
    "various",
    "youtube",
    "youtube music",
    "topic"
  ].includes(value);
}

function artistMatches(actual, wanted) {
  const a = normalizeArtist(actual).toLowerCase();
  const w = normalizeArtist(wanted).toLowerCase();

  if (!a || !w) return false;
  if (a === w) return true;
  if (a.includes(w)) return true;
  if (w.includes(a)) return true;

  // Handle common YouTube multi-artist metadata such as
  // "Ed Sheeran, Topic" or "Ed Sheeran & ...".
  const parts = a.split(/\s*(?:,|&|feat\.?|ft\.?)\s*/i);
  return parts.some(part => part === w || part.includes(w) || w.includes(part));
}

function titleLooksRelevant(title, artist) {
  const t = clean(title).toLowerCase();
  const a = normalizeArtist(artist).toLowerCase();
  if (!t || !a) return false;

  const words = a.split(/\s+/).filter(Boolean);
  if (!words.length) return false;

  const hits = words.filter(word => t.includes(word)).length;
  return hits >= Math.max(1, Math.ceil(words.length * 0.5));
}

function trackId(manager, track) {
  return manager.getTrackId(track);
}

Module._load = function(request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments);

  if (
    !patched &&
    typeof exported === "function" &&
    /(^|[\\/])music[\\/]MusicManager$/.test(request)
  ) {
    patched = true;

    // ------------------------------------------------------------
    // Prevent concurrent 24/7 startup/recovery calls from creating
    // multiple Kazagumo players for the same guild.
    // ------------------------------------------------------------
    const originalEnsure247 = exported.prototype.ensure247;

    exported.prototype.ensure247 = async function(guildId) {
      guildId = guildId || this.musicGuildId;

      if (!guildId) {
        return originalEnsure247.call(this, guildId);
      }

      if (!this._ensure247Locks) {
        this._ensure247Locks = new Map();
      }

      const existing = this._ensure247Locks.get(guildId);
      if (existing) {
        return existing;
      }

      const promise = originalEnsure247.call(this, guildId);
      this._ensure247Locks.set(guildId, promise);

      try {
        return await promise;
      } finally {
        if (this._ensure247Locks.get(guildId) === promise) {
          this._ensure247Locks.delete(guildId);
        }
      }
    };

    // ------------------------------------------------------------
    // Remember the user's actual /play query and the selected artist.
    // The query is saved BEFORE the player starts so autoplay always has
    // context even if playerStart fires with incomplete metadata.
    // ------------------------------------------------------------
    const originalPlay = exported.prototype.play;

    exported.prototype.play = async function(args) {
      const guildId = args?.guildId;
      const state = guildId ? this.getState(guildId) : null;
      const query = clean(args?.query);

      if (state && query) {
        state.autoplayContext = {
          query,
          artist: clean(state.autoplayContext?.artist),
          title: clean(state.autoplayContext?.title)
        };
      }

      const result = await originalPlay.call(this, args);

      if (state) {
        const track = result?.track || result?.tracks?.[0] || args?.track || null;
        const rawArtist = track ? this.getTrackAuthor(track) : "";
        const artist = normalizeArtist(rawArtist);

        state.autoplayContext = {
          query,
          artist: isGenericArtist(artist) ? "" : artist,
          title: clean(track ? this.getTrackTitle(track) : "")
        };
      }

      return result;
    };

    // ------------------------------------------------------------
    // Context-aware autoplay.
    // ------------------------------------------------------------
    exported.prototype.autoplayNext = async function(
      guildId,
      player = this.getPlayer(guildId)
    ) {
      if (!player) return false;

      const state = this.getState(guildId);
      if (!state.autoplay) return false;
      if (this.autoplayBusy.has(guildId)) return false;

      // Never autoplay over a manually queued track.
      if (
        player.playing ||
        player.paused ||
        player.queue?.current ||
        (player.queue?.length || 0) > 0
      ) {
        return false;
      }

      this.autoplayBusy.add(guildId);
      const generation = state.autoplayGeneration || 0;

      try {
        const recent = this.recentTracks.get(guildId) || [];
        const context = state.autoplayContext || {};
        const artist = normalizeArtist(context.artist);
        const query = clean(context.query);

        // Artist is the primary context. The original search is the
        // secondary context. This means /play "Ed Sheeran - Perfect"
        // continues with Ed Sheeran instead of a random genre/video.
        const seeds = [];
        if (artist) {
          seeds.push(`${artist} songs`);
          seeds.push(artist);
        } else if (query) {
          seeds.push(query);
        } else {
          seeds.push("popular music");
        }

        let chosen = null;

        for (const seed of seeds) {
          const identifiers = [
            `ytmsearch:${seed}`,
            `ytsearch:${seed}`
          ];

          for (const identifier of identifiers) {
            try {
              const result = await this.kazagumo.search(identifier, {
                requester: this.client.user
              });

              if (!result?.tracks?.length) continue;

              let candidates = result.tracks.filter(track => {
                const id = trackId(this, track);
                return id && !recent.includes(id);
              });

              if (!candidates.length) continue;

              if (artist) {
                // Strong priority 1: metadata says it is the same artist.
                const metadataMatches = candidates.filter(track =>
                  artistMatches(this.getTrackAuthor(track), artist)
                );

                if (metadataMatches.length) {
                  candidates = metadataMatches;
                } else {
                  // Strong priority 2: title itself contains the artist name.
                  const titleMatches = candidates.filter(track =>
                    titleLooksRelevant(this.getTrackTitle(track), artist)
                  );

                  if (titleMatches.length) {
                    candidates = titleMatches;
                  } else {
                    // Do not pick an unrelated result merely because the
                    // search returned something. Try the next seed/search.
                    continue;
                  }
                }
              }

              // Prefer a normal music-length track over obvious shorts,
              // clips, tutorials and other non-music results.
              const sensible = candidates.filter(track => {
                const title = this.getTrackTitle(track).toLowerCase();
                return !/(shorts?|tiktok|tutorial|how to|funny|reaction)/i.test(title);
              });

              if (sensible.length) {
                candidates = sensible;
              }

              chosen = candidates[Math.floor(Math.random() * candidates.length)];
              break;
            } catch (error) {
              console.warn(
                `⚠️ Context autoplay search failed for ${identifier}:`,
                error?.message || error
              );
            }
          }

          if (chosen) break;
        }

        if (
          !chosen ||
          (state.autoplayGeneration || 0) !== generation
        ) {
          return false;
        }

        if (
          player.playing ||
          player.paused ||
          player.queue?.current ||
          (player.queue?.length || 0) > 0
        ) {
          return false;
        }

        const id = trackId(this, chosen);
        if (id) {
          this.recentTracks.set(
            guildId,
            [...recent, id].slice(-20)
          );
        }

        player.queue.add(chosen);

        if (!player.playing && !player.paused) {
          await player.play();
        }

        console.log(
          `🎯 Context autoplay queued: ${this.getTrackTitle(chosen)} — ${this.getTrackAuthor(chosen)}`
        );

        return true;
      } catch (error) {
        console.error(
          "❌ Context autoplay error:",
          error?.message || error
        );
        return false;
      } finally {
        this.autoplayBusy.delete(guildId);
      }
    };
  }

  return exported;
};
