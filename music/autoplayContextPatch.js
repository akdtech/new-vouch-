"use strict";

/*
 * Context-aware autoplay patch.
 * Loaded before index.js so the existing MusicManager keeps all of its
 * normal controls while autoplay follows the song/search the user chose.
 */
const Module = require("module");
const originalLoad = Module._load;

let patched = false;

function clean(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericArtist(artist) {
  const value = clean(artist).toLowerCase();
  return !value || [
    "unknown artist",
    "various artists",
    "various",
    "youtube",
    "youtube music",
    "topic"
  ].includes(value);
}

Module._load = function(request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments);

  if (
    !patched &&
    typeof exported === "function" &&
    /(^|[\\/])music[\\/]MusicManager$/.test(request)
  ) {
    patched = true;

    const originalPlay = exported.prototype.play;

    exported.prototype.play = async function(args) {
      const result = await originalPlay.call(this, args);
      const state = this.getState(args.guildId);
      const track = result?.track || args?.track || null;
      const artist = clean(
        track ? this.getTrackAuthor(track) : ""
      );

      state.autoplayContext = {
        query: clean(args.query),
        artist: isGenericArtist(artist) ? "" : artist,
        title: clean(track ? this.getTrackTitle(track) : "")
      };

      return result;
    };

    exported.prototype.autoplayNext = async function(
      guildId,
      player = this.getPlayer(guildId)
    ) {
      if (!player) return false;

      const state = this.getState(guildId);
      if (!state.autoplay) return false;
      if (this.autoplayBusy.has(guildId)) return false;

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
        const artist = clean(context.artist);
        const query = clean(context.query);

        // Prefer the actual artist from the song. If the track has no useful
        // artist metadata, fall back to the user's original search.
        const seeds = [];
        if (artist) seeds.push(artist);
        if (query && !seeds.some(x => x.toLowerCase() === query.toLowerCase())) {
          seeds.push(query);
        }

        // A fresh 24/7 server with no user-selected song still gets a useful
        // music search, but never the old random multi-genre list.
        if (!seeds.length) seeds.push("popular music");

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
                const id = this.getTrackId(track);
                return id && !recent.includes(id);
              });

              // When we know the artist, strongly prefer tracks whose metadata
              // matches that artist. This prevents unrelated YouTube results.
              if (artist) {
                const matchingArtist = candidates.filter(track => {
                  const a = clean(this.getTrackAuthor(track)).toLowerCase();
                  const wanted = artist.toLowerCase();
                  return a === wanted || a.includes(wanted) || wanted.includes(a);
                });

                if (matchingArtist.length) {
                  candidates = matchingArtist;
                }
              }

              if (candidates.length) {
                chosen = candidates[Math.floor(Math.random() * candidates.length)];
                break;
              }
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

        const id = this.getTrackId(chosen);
        if (id) {
          this.recentTracks.set(
            guildId,
            [...recent, id].slice(-15)
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
