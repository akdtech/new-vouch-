"use strict";

/* DEATH direct autoplay intelligence: short songs + related artist/genre chaining. */
const MusicManager = require("./DirectMusicManager");
const MAX_AUTOPLAY_MS = 8 * 60 * 1000;
const IDEAL_MIN_MS = 90 * 1000;
const IDEAL_MAX_MS = 6 * 60 * 1000;
const AUTOPLAY_BLOCK_MS = 20 * 1000;
const MAX_SOURCE_ATTEMPTS = 3;
const PIPED_SEARCH_TIMEOUT_MS = 3500;
const PIPED_SEARCH_INSTANCES = String(process.env.PIPED_API_URLS || [
  "https://pipedapi.ducks.party",
  "https://api.piped.private.coffee",
  "https://pipedapi.leptons.xyz",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.darkness.services",
  "https://pipedapi.owo.si"
].join(",")).split(",").map(v => v.trim().replace(/\/+$/, "")).filter(Boolean);

const BAD_TITLE = /\b(\d+\s*(?:hour|hr)s?|hour\s*mix|\bmix\b|playlist|compilation|continuous|non\s*stop|radio|medley|full\s*album|album|collection|lofi\s*mix|sleep\s*music|long\s*version|dj\s*remix)\b/i;
const STOP_WORDS = new Set(["the","a","an","and","or","of","to","for","in","on","at","with","from","is","it","my","your","me","you","official","video","audio","music","song","songs","lyrics","lyric","remix","edit","version","full","hd","4k","feat","ft"]);

function clean(value){return String(value || "").replace(/\s+/g," ").trim();}
function artistIsUseful(artist){const v=clean(artist).toLowerCase();return v&&!['unknown artist','various artists','various','youtube','youtube music','topic','unknown'].includes(v);}
function words(value){return clean(value).toLowerCase().replace(/[^a-z0-9\s]/gi," ").split(/\s+/).filter(w=>w.length>=3&&!STOP_WORDS.has(w));}
function artistMatches(a,b){const l=clean(a).toLowerCase(),r=clean(b).toLowerCase();return !!l&&!!r&&(l===r||l.includes(r)||r.includes(l));}
function trackId(track){return track?.identifier||track?.id||track?.url;}
function isAutoplayCandidate(track){const title=clean(track?.title),length=Number(track?.length||0);return Number.isFinite(length)&&length>0&&length<=MAX_AUTOPLAY_MS&&!BAD_TITLE.test(title);}
function candidateScore(track,context,recent){const title=clean(track?.title),artist=clean(track?.author||track?.uploader),length=Number(track?.length||0),haystack=`${title} ${artist}`.toLowerCase();let score=0;if(artistMatches(artist,context.artist))score+=150;for(const word of context.words||[])if(haystack.includes(word))score+=20;if(length>=IDEAL_MIN_MS&&length<=IDEAL_MAX_MS)score+=25;else if(length>IDEAL_MAX_MS)score-=5;else score-=5;const id=trackId(track);if(id&&recent.includes(id))score-=1000;return score;}
function isYoutubeBotBlock(error){const text=String(error?.message||error||"").toLowerCase();return text.includes("sign in to confirm")||text.includes("not a bot")||text.includes("login_required")||text.includes("bot-check");}

async function pipedSearch(query, requester){
  const q=clean(query);
  if(!q)return [];
  const request=async base=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),PIPED_SEARCH_TIMEOUT_MS);
    try{
      const response=await fetch(`${base}/search?q=${encodeURIComponent(q)}&filter=music_songs`,{
        headers:{accept:"application/json","user-agent":"DEATH-Music-24-7/1.0"},
        signal:controller.signal,
        redirect:"follow"
      });
      if(!response.ok)throw new Error(`Piped HTTP ${response.status}`);
      const data=await response.json();
      const items=Array.isArray(data?.items)?data.items:[];
      return items.filter(x=>x?.type==="stream"&&x?.url&&x?.title).map(x=>{
        const id=String(x.url).match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1]||String(x.url).split("/watch?v=")[1]?.split("&")[0];
        if(!id)return null;
        return {
          identifier:id,id,url:`https://www.youtube.com/watch?v=${id}`,
          title:clean(x.title),author:clean(x.uploaderName)||"Unknown artist",
          length:Number(x.duration||0)*1000,requester,
          thumbnail:x.thumbnail||`https://i.ytimg.com/vi/${id}/hqdefault.jpg`,isAutoplay:false,source:"piped-search"
        };
      }).filter(Boolean).slice(0,8);
    }finally{clearTimeout(timer);}
  };
  try{
    const result=await Promise.any(PIPED_SEARCH_INSTANCES.map(request));
    if(result?.length)console.log(`🔎 Piped autoplay search success: ${result[0].title}`);
    return result||[];
  }catch{return []}
}

const originalPlay=MusicManager.prototype.play;
MusicManager.prototype.play=async function patchedPlay(args){
  const result=await originalPlay.call(this,args),state=this.getState(args.guildId),track=result?.track||state.current||null,title=clean(track?.title),artist=clean(track?.author||track?.uploader),query=clean(args?.query);
  state.autoplayBlockedUntil=0;
  state.autoplayBlockNoticeUntil=0;
  state.autoplayContext={artist:artistIsUseful(artist)?artist:"",title,query,words:[...new Set([...words(title),...words(query)])].slice(0,8)};
  console.log(`🎯 Autoplay context: ${artist||"search/genre"}${title?` — ${title}`:""}`);
  return result;
};

MusicManager.prototype.autoplayNext=async function contextAwareAutoplay(guildId){
  const state=this.getState(guildId),player=this.players.get(guildId);
  if(!player||!state.autoplay||state.intentionalLeave||state.autoplayBusy)return false;
  if(state.current||state.queue.length)return false;
  if(Number(state.autoplayBlockedUntil||0)>Date.now())return false;
  state.autoplayBusy=true;
  try{
    const context=state.autoplayContext||{},recent=Array.isArray(state.recent)?state.recent:[];
    const artist=clean(context.artist);
    const contextTitle=clean(context.title);
    const contextQuery=clean(context.query);
    const contextWords=Array.isArray(context.words)&&context.words.length ? context.words : words(`${contextTitle} ${contextQuery}`);
    const queries=[];

    if(artist){
      queries.push(`${artist} songs official audio`);
      if(contextWords.length)queries.push(`${artist} ${contextWords.slice(0,2).join(" ")} official audio`);
      queries.push(`${artist} latest song`);
    }
    if(contextWords.length){
      queries.push(`${contextWords.slice(0,3).join(" ")} songs official audio`);
      if(contextQuery)queries.push(`${contextQuery} similar songs`);
    }
    if(!queries.length){
      queries.push("popular songs 2026 official audio");
      queries.push("top songs 2026 single official audio");
      queries.push("trending songs 2026 individual songs");
    }

    const ranked = new Map();
    for(const query of [...new Set(queries)]){
      if(/\bundefined\b|\bnull\b/i.test(query))continue;
      let tracks=[];
      try{
        const result=await this.search(query,this.client.user);
        tracks=result?.tracks||[];
      }catch(error){
        if(isYoutubeBotBlock(error))console.warn(`⚠️ Autoplay primary search blocked: ${query}`);
        else console.warn(`⚠️ Context autoplay search failed: ${query} — ${error?.message||error}`);
      }

      let candidates=tracks.filter(isAutoplayCandidate).filter(track=>!recent.includes(trackId(track)));
      if(!candidates.length) candidates=await pipedSearch(query,this.client.user);
      for(const track of candidates.filter(isAutoplayCandidate).filter(track=>!recent.includes(trackId(track)))){
        const id=trackId(track);if(!id)continue;
        const score=candidateScore(track,{artist,words:contextWords},recent);
        const old=ranked.get(id);
        if(!old||score>old.score)ranked.set(id,{track,score});
      }
    }

    const candidates=[...ranked.values()].sort((a,b)=>b.score-a.score).slice(0,12);
    if(!candidates.length){
      const pipedFallback=await pipedSearch("popular songs 2026 official audio",this.client.user);
      for(const track of pipedFallback.filter(isAutoplayCandidate).filter(track=>!recent.includes(trackId(track)))){
        const id=trackId(track);if(id)ranked.set(id,{track,score:candidateScore(track,{artist,words:contextWords},recent)});
      }
    }

    const attempts=[...ranked.values()].sort((a,b)=>b.score-a.score).slice(0,MAX_SOURCE_ATTEMPTS);
    let lastError=null;
    for(const candidate of attempts){
      const chosen=candidate.track;
      const id=trackId(chosen);
      try{
        if(id)state.recent=[...recent,id].slice(-20);
        chosen.isAutoplay=true;
        chosen.autoplayGroup=artist?`Same artist / related: ${artist}`:"Related search / genre";
        const chosenArtist=clean(chosen.author||chosen.uploader);
        state.autoplayContext={
          artist:artistIsUseful(chosenArtist)?chosenArtist:artist,
          title:clean(chosen.title),
          query:contextQuery||clean(chosen.title),
          words:[...new Set([...(contextWords||[]),...words(chosen.title)])].slice(0,10)
        };

        await this.startTrack(guildId,chosen);
        state.autoplayBlockedUntil=0;
        console.log(`🎯 Short-track autoplay started: ${this.getTrackTitle(chosen)} — ${this.getTrackAuthor(chosen)} | ${chosen.autoplayGroup} | max=8m`);
        return true;
      }catch(error){
        lastError=error;
        console.warn(`⚠️ Autoplay source failed; trying another track: ${this.getTrackTitle(chosen)} — ${error?.message||error}`);
      }
    }

    state.current=null;
    state.transitioning=false;
    if(isYoutubeBotBlock(lastError)){
      state.autoplayBlockedUntil=Date.now()+AUTOPLAY_BLOCK_MS;
      console.warn(`⏸️ Autoplay source recovery cooling down briefly (${AUTOPLAY_BLOCK_MS/1000}s); it will retry automatically.`);
    }else{
      state.autoplayBlockedUntil=Date.now()+5000;
      console.warn("⏸️ Autoplay source recovery cooling down briefly (5s); it will retry automatically.");
    }
    Promise.resolve(this.refreshPanel?.(guildId)).catch(()=>{});
    return false;
  }catch(error){
    state.transitioning=false;
    state.current=null;
    state.autoplayBlockedUntil=Date.now()+5000;
    console.error("❌ Context autoplay error:",error?.message||error);
    Promise.resolve(this.refreshPanel?.(guildId)).catch(()=>{});
    return false;
  }finally{state.autoplayBusy=false;}
};

console.log("🎯 DEATH smart autoplay loaded: related songs + hard 8-minute maximum + artist/genre chaining + multi-track source recovery.");
