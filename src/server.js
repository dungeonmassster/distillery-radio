import express from "express";
import si from "systeminformation";
import YouTube from "youtube-sr";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import OpenAI from "openai";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Don't let one bad request kill the process while we're tunneled to the public internet.
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err && err.stack ? err.stack : err);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.stack ? err.stack : err);
});

const app = express();
const PORT = process.env.PORT || 3456;
const PUBLIC_URL = process.env.PUBLIC_URL || "";

app.set("trust proxy", true); // honor X-Forwarded-For (Cloudflare Tunnel etc.)
app.use(express.static(join(__dirname, "../public")));
app.use(express.json({ limit: "32kb" }));

// ── YouTube ID cache ───────────────────────────────────────────────
const CACHE_PATH = join(__dirname, "../youtube-cache.json");

let youtubeCache = {};
if (existsSync(CACHE_PATH)) {
  try {
    youtubeCache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
    console.log(`  YouTube cache loaded: ${Object.keys(youtubeCache).length} entries`);
  } catch (e) {
    console.warn("  YouTube cache corrupted, starting fresh");
    youtubeCache = {};
  }
}

function saveCache() {
  writeFileSync(CACHE_PATH, JSON.stringify(youtubeCache, null, 2));
}

// ── TTS voices ─────────────────────────────────────────────────────
const TTS_VOICES = [
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓", gender: "female", desc: "温柔自然" },
  { id: "zh-CN-YunxiNeural", name: "云希", gender: "male", desc: "专业磁性" },
  { id: "zh-CN-YunyangNeural", name: "云扬", gender: "male", desc: "新闻播报" },
  { id: "zh-CN-XiaohanNeural", name: "晓涵", gender: "female", desc: "温暖知性" },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊", gender: "female", desc: "活泼清新" },
];

// ── DeepSeek config ────────────────────────────────────────────────
const envDeepseekApiKey = process.env.DEEPSEEK_API_KEY || "";
// Per-IP DeepSeek keys so public visitors can use their own without affecting others
const deepseekKeysByIp = new Map();

function clientIp(req) {
  return (req.headers["x-forwarded-for"]?.split(",")[0]?.trim()) || req.ip || "anon";
}

function getDeepSeekKey(req) {
  return deepseekKeysByIp.get(clientIp(req)) || envDeepseekApiKey;
}

function getDeepSeekClient(req) {
  const key = getDeepSeekKey(req);
  if (!key) return null;
  return new OpenAI({ apiKey: key, baseURL: "https://api.deepseek.com" });
}

// ── Simple in-memory cache + per-IP rate limit for /api/search ────
const searchCache = new Map(); // q -> { items, expiresAt }
const SEARCH_TTL_MS = 5 * 60 * 1000;
const searchHitsByIp = new Map(); // ip -> [timestamps]
const SEARCH_RATE_WINDOW_MS = 60 * 1000;
const SEARCH_RATE_MAX = 30; // 30 search calls per minute per IP

function searchRateLimited(ip) {
  const now = Date.now();
  const arr = (searchHitsByIp.get(ip) || []).filter((t) => now - t < SEARCH_RATE_WINDOW_MS);
  if (arr.length >= SEARCH_RATE_MAX) {
    searchHitsByIp.set(ip, arr);
    return true;
  }
  arr.push(now);
  searchHitsByIp.set(ip, arr);
  return false;
}

async function resolveYouTubeId(title, artist, altQuery = false) {
  const cacheKey = `${title} - ${artist}`;
  if (!altQuery && youtubeCache[cacheKey]) return youtubeCache[cacheKey];

  try {
    // Try different query patterns to find embeddable versions
    const queries = altQuery
      ? [
          `${title} ${artist} full song`,
          `${title} ${artist}`,
          `${artist} ${title} audio`,
        ]
      : [`${title} ${artist} official audio`];

    for (const query of queries) {
      const results = await YouTube.default.search(query, { limit: 5, type: "video" });
      if (!results.length) continue;

      // Score results: prefer official audio, reject covers/remixes/compilations
      const scored = results.map((r) => {
        let score = 0;
        const t = (r.title || "").toLowerCase();
        const ch = (r.channel?.name || "").toLowerCase();
        if (t.includes("official")) score += 3;
        if (t.includes("audio")) score += 2;
        if (t.includes("lyric")) score += 1;
        if (t.includes("topic")) score += 2; // YouTube auto-generated "Topic" channels are always embeddable
        if (ch.includes("topic")) score += 3;
        if (ch.includes("vevo")) score += 2;
        if (t.includes("live")) score -= 2;
        if (t.includes("cover")) score -= 5;
        if (t.includes("remix")) score -= 5;
        if (t.includes("karaoke")) score -= 5;
        if (t.includes("tutorial")) score -= 5;
        const dur = (r.duration || 0) / 1000;
        if (dur > 60 && dur < 600) score += 2;
        if (dur > 900) score -= 3;
        return { id: r.id, score, title: r.title };
      });
      scored.sort((a, b) => b.score - a.score);

      if (scored[0]) {
        const bestId = scored[0].id;
        youtubeCache[cacheKey] = bestId;
        saveCache();
        console.log(`  ♫ Resolved: ${cacheKey} → ${bestId} (${scored[0].title})`);
        return bestId;
      }
    }
    return null;
  } catch (e) {
    console.error(`  YouTube search failed for ${cacheKey}:`, e.message);
    return null;
  }
}

// ── Weather (Shanghai, free API no key needed) ──────────────────────
let weatherCache = { data: null, expiresAt: 0 };
const WEATHER_TTL_MS = 10 * 60 * 1000;

async function getWeather() {
  const now = Date.now();
  if (weatherCache.data && weatherCache.expiresAt > now) {
    return weatherCache.data;
  }
  try {
    // wttr.in occasionally returns plain-text rate-limit messages or hangs.
    // Hard-cap with AbortController so /api/context can't be wedged forever.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch("https://wttr.in/Shanghai?format=j1", { signal: ctrl.signal });
    clearTimeout(t);
    const data = await res.json();
    const cur = data.current_condition?.[0] || {};
    const fresh = {
      temp_c: cur.temp_C || "22",
      feelslike_c: cur.FeelsLikeC || "22",
      humidity: cur.humidity || "60",
      desc: cur.weatherDesc?.[0]?.value || "Clear",
      windspeed_kmh: cur.windspeedKmph || "10",
      cloud_cover: cur.cloudcover || "20",
      uv_index: cur.uvIndex || "0",
      visibility: cur.visibility || "10",
      pressure: cur.pressure || "1013",
    };
    weatherCache = { data: fresh, expiresAt: now + WEATHER_TTL_MS };
    return fresh;
  } catch (e) {
    console.error("Weather fetch failed:", e.message);
    // Serve stale cache if we have it; only fall through to defaults if no cache yet
    if (weatherCache.data) return weatherCache.data;
    return {
      temp_c: "22", feelslike_c: "22", humidity: "60",
      desc: "Clear", windspeed_kmh: "10", cloud_cover: "50",
      uv_index: "0", visibility: "10", pressure: "1013",
    };
  }
}

// ── System stats ────────────────────────────────────────────────────
async function getSystemStats() {
  try {
    const [cpu, mem, battery, load, processes] = await Promise.all([
      si.cpu(), si.mem(), si.battery(), si.currentLoad(), si.processes(),
    ]);
    return {
      cpu_brand: cpu.brand,
      cpu_load_percent: load.currentLoad?.toFixed(1) || "0",
      mem_used_gb: (mem.used / 1073741824).toFixed(1),
      mem_total_gb: (mem.total / 1073741824).toFixed(1),
      mem_percent: ((mem.used / mem.total) * 100).toFixed(1),
      battery_percent: battery.percent ?? "N/A",
      battery_charging: battery.isCharging ?? false,
      process_count: processes.all ?? 0,
      top_processes: (processes.list || [])
        .sort((a, b) => b.cpu - a.cpu)
        .slice(0, 5)
        .map((p) => ({ name: p.name, cpu: p.cpu?.toFixed(1) })),
    };
  } catch (e) {
    console.error("System stats failed:", e.message);
    return {
      cpu_brand: "Unknown", cpu_load_percent: "30",
      mem_used_gb: "8", mem_total_gb: "16", mem_percent: "50",
      battery_percent: "80", battery_charging: false,
      process_count: 100, top_processes: [],
    };
  }
}

// ── Time context ────────────────────────────────────────────────────
function getTimeContext() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const hour = now.getHours();
  const minute = now.getMinutes();
  const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  let period;
  if (hour >= 0 && hour < 5) period = "deep_night";
  else if (hour >= 5 && hour < 8) period = "early_morning";
  else if (hour >= 8 && hour < 12) period = "morning";
  else if (hour >= 12 && hour < 14) period = "noon";
  else if (hour >= 14 && hour < 17) period = "afternoon";
  else if (hour >= 17 && hour < 19) period = "evening";
  else if (hour >= 19 && hour < 22) period = "night";
  else period = "late_night";
  return {
    hour, minute, period,
    dayOfWeek: dayNames[now.getDay()],
    formatted: `${String(hour).padStart(2,"0")}:${String(minute).padStart(2,"0")}`,
    isWeekend: now.getDay() === 0 || now.getDay() === 6,
  };
}

// ═══════════════════════════════════════════════════════════════════
// ── Built-in Distillery Radio Engine (no external AI needed) ──────
// ═══════════════════════════════════════════════════════════════════

// ── Song database with mood tags ────────────────────────────────
const SONGS = [
  // Deep night / serene
  { title: "Gymnopdie No.1", artist: "Erik Satie", album: "Gymnopedies", year: "1888", genre: "Classical", moods: ["serene","melancholy","night","rainy","quiet"], weight: { deep_night: 9, late_night: 8, rain: 7, low_load: 8 } },
  { title: "Clair de Lune", artist: "Claude Debussy", album: "Suite bergamasque", year: "1905", genre: "Classical", moods: ["dreamy","night","moonlit","serene"], weight: { deep_night: 9, late_night: 8, clear_sky: 8, low_load: 7 } },
  { title: "Comptine d'un autre ete", artist: "Yann Tiersen", album: "Amelie OST", year: "2001", genre: "Soundtrack", moods: ["nostalgic","warm","gentle","hopeful"], weight: { evening: 8, night: 7, cool_weather: 7, medium_load: 6 } },
  { title: "River Flows in You", artist: "Yiruma", album: "First Love", year: "2001", genre: "New Age", moods: ["romantic","gentle","flowing","peaceful"], weight: { night: 8, late_night: 7, rainy: 6, low_load: 8 } },
  { title: "Experience", artist: "Ludovico Einaudi", album: "In a Time Lapse", year: "2013", genre: "Classical Crossover", moods: ["epic","emotional","building","vast"], weight: { evening: 7, night: 6, windy: 7, medium_load: 7 } },
  { title: "Nuvole Bianche", artist: "Ludovico Einaudi", album: "Una Mattina", year: "2004", genre: "Classical Crossover", moods: ["gentle","hopeful","dawn","light"], weight: { early_morning: 9, morning: 8, clear_sky: 7, low_load: 7 } },

  // Ambient / Electronic
  { title: "Intro", artist: "The xx", album: "xx", year: "2009", genre: "Indie", moods: ["intimate","dark","minimal","cool"], weight: { late_night: 9, deep_night: 8, cool_weather: 7, low_load: 7 } },
  { title: "Midnight City", artist: "M83", album: "Hurry Up, We're Dreaming", year: "2011", genre: "Synth Pop", moods: ["neon","urban","night","energetic"], weight: { night: 8, late_night: 7, high_load: 6, urban: 8 } },
  { title: "Shelter", artist: "Porter Robinson & Madeon", album: "Shelter", year: "2016", genre: "Electronic", moods: ["hopeful","bright","emotional","digital"], weight: { afternoon: 7, evening: 8, high_load: 6, charging: 7 } },
  { title: "Resonance", artist: "HOME", album: "Odyssey", year: "2014", genre: "Synthwave", moods: ["nostalgic","neon","dreamy","retro"], weight: { late_night: 9, deep_night: 8, medium_load: 7, coding: 7 } },
  { title: "Flim", artist: "Aphex Twin", album: "Come to Daddy", year: "1997", genre: "IDM", moods: ["playful","melancholy","electronic","gentle"], weight: { deep_night: 7, morning: 6, medium_load: 7, coding: 8 } },
  { title: "Avril 14th", artist: "Aphex Twin", album: "Drukqs", year: "2001", genre: "Ambient", moods: ["delicate","solitary","quiet","reflective"], weight: { deep_night: 9, late_night: 8, rain: 7, low_load: 9 } },
  { title: "An Ending (Ascent)", artist: "Brian Eno", album: "Apollo", year: "1983", genre: "Ambient", moods: ["vast","serene","cosmic","transcendent"], weight: { deep_night: 8, clear_sky: 8, low_load: 9, night: 7 } },
  { title: "Music for Airports 1/1", artist: "Brian Eno", album: "Ambient 1", year: "1978", genre: "Ambient", moods: ["spacious","calm","minimal","floating"], weight: { morning: 7, afternoon: 6, low_load: 8, clear_sky: 6 } },
  { title: "Weightless", artist: "Marconi Union", album: "Weightless", year: "2011", genre: "Ambient", moods: ["calming","therapeutic","floating","slow"], weight: { deep_night: 8, late_night: 7, high_load: 9, hot_weather: 6 } },

  // Jazz
  { title: "Blue in Green", artist: "Miles Davis", album: "Kind of Blue", year: "1959", genre: "Jazz", moods: ["melancholy","cool","contemplative","night"], weight: { late_night: 9, deep_night: 8, rain: 8, cool_weather: 8 } },
  { title: "My Funny Valentine", artist: "Chet Baker", album: "Chet Baker Sings", year: "1954", genre: "Vocal Jazz", moods: ["romantic","intimate","melancholy","tender"], weight: { late_night: 8, deep_night: 7, rain: 7, low_load: 8 } },
  { title: "So What", artist: "Miles Davis", album: "Kind of Blue", year: "1959", genre: "Jazz", moods: ["cool","confident","smooth","night"], weight: { night: 8, evening: 7, medium_load: 7, cool_weather: 6 } },
  { title: "In a Sentimental Mood", artist: "Duke Ellington & John Coltrane", album: "Duke Ellington & John Coltrane", year: "1963", genre: "Jazz", moods: ["warm","nostalgic","elegant","romantic"], weight: { evening: 8, night: 9, rain: 7, weekend: 7 } },
  { title: "Misty", artist: "Erroll Garner", album: "Contrasts", year: "1954", genre: "Jazz", moods: ["warm","foggy","romantic","gentle"], weight: { night: 7, fog: 9, humid: 7, low_load: 6 } },
  { title: "Take Five", artist: "Dave Brubeck", album: "Time Out", year: "1959", genre: "Jazz", moods: ["cool","sophisticated","rhythmic","urban"], weight: { afternoon: 7, evening: 8, medium_load: 7, coding: 6 } },

  // Post-rock / Indie
  { title: "Your Hand in Mine", artist: "Explosions in the Sky", album: "The Earth Is Not a Cold Dead Place", year: "2003", genre: "Post-Rock", moods: ["emotional","building","warm","vast"], weight: { evening: 8, night: 7, clear_sky: 7, medium_load: 6 } },
  { title: "First Breath After Coma", artist: "Explosions in the Sky", album: "The Earth Is Not a Cold Dead Place", year: "2003", genre: "Post-Rock", moods: ["hopeful","dawn","rebirth","emotional"], weight: { early_morning: 9, morning: 8, clear_sky: 7, low_load: 7 } },
  { title: "Storm", artist: "Godspeed You! Black Emperor", album: "Lift Your Skinny Fists", year: "2000", genre: "Post-Rock", moods: ["epic","dark","building","stormy"], weight: { night: 7, storm: 9, windy: 8, high_load: 7 } },
  { title: "Holocene", artist: "Bon Iver", album: "Bon Iver", year: "2011", genre: "Indie Folk", moods: ["vast","solitary","winter","contemplative"], weight: { deep_night: 7, cold_weather: 8, clear_sky: 7, low_load: 7 } },
  { title: "Skinny Love", artist: "Bon Iver", album: "For Emma, Forever Ago", year: "2007", genre: "Indie Folk", moods: ["raw","emotional","winter","lonely"], weight: { late_night: 8, cold_weather: 8, rain: 6, low_load: 7 } },
  { title: "To Build a Home", artist: "The Cinematic Orchestra", album: "Ma Fleur", year: "2007", genre: "Cinematic", moods: ["emotional","building","warm","nostalgic"], weight: { evening: 8, night: 7, cool_weather: 7, low_load: 7 } },

  // Lo-fi / Chill
  { title: "Snowman", artist: "WYS", album: "Snowman", year: "2020", genre: "Lo-fi", moods: ["chill","cozy","warm","gentle"], weight: { night: 7, late_night: 6, cold_weather: 8, coding: 7 } },
  { title: "Affection", artist: "Jinsang", album: "Life", year: "2018", genre: "Lo-fi Hip Hop", moods: ["warm","nostalgic","chill","gentle"], weight: { afternoon: 7, evening: 7, medium_load: 7, coding: 8 } },
  { title: "Luv Letter", artist: "DJ Okawari", album: "Luv Letter", year: "2008", genre: "Jazz Hop", moods: ["warm","hopeful","gentle","flowing"], weight: { morning: 7, afternoon: 7, clear_sky: 6, medium_load: 7 } },

  // Chinese indie / Chinese music
  { title: "Crowd Lu", artist: "Crowd Lu", album: "Your Woman", year: "2008", genre: "Mandopop", moods: ["warm","nostalgic","gentle","romantic"], weight: { evening: 7, night: 7, cool_weather: 6, low_load: 6 } },
  { title: "Night is Young", artist: "Sunset Rollercoaster", album: "Cassa Nova", year: "2018", genre: "City Pop / Indie", moods: ["groovy","urban","night","romantic"], weight: { night: 9, late_night: 7, warm_weather: 7, weekend: 8 } },
  { title: "My Dear Art", artist: "Sunset Rollercoaster", album: "Cassa Nova", year: "2018", genre: "City Pop / Indie", moods: ["dreamy","retro","summer","groovy"], weight: { evening: 8, warm_weather: 8, weekend: 7, low_load: 6 } },
  { title: "I Know", artist: "Faye Wong", album: "Restless", year: "1999", genre: "Mandopop", moods: ["ethereal","dreamy","distant","delicate"], weight: { deep_night: 7, late_night: 8, rain: 7, fog: 7 } },
  { title: "Red Bean", artist: "Faye Wong", album: "To Love", year: "2003", genre: "Mandopop", moods: ["tender","bittersweet","warm","reflective"], weight: { late_night: 7, rain: 7, cool_weather: 7, low_load: 7 } },
  { title: "Spring Breeze", artist: "Eason Chan", album: "U87", year: "2005", genre: "Cantopop", moods: ["warm","breezy","gentle","nostalgic"], weight: { morning: 7, afternoon: 7, windy: 7, clear_sky: 7 } },
  { title: "Let's Not Be Friends", artist: "Eric Chou", album: "My Way To Love", year: "2015", genre: "Mandopop", moods: ["melancholy","emotional","night","intimate"], weight: { late_night: 8, night: 7, rain: 7, low_load: 7 } },
  { title: "Fly Me To The Moon", artist: "Olivia Ong", album: "A Girl Meets Bossa Nova 2", year: "2006", genre: "Bossa Nova", moods: ["warm","romantic","light","playful"], weight: { evening: 8, clear_sky: 7, warm_weather: 7, weekend: 7 } },
  { title: "Life in Technicolor", artist: "Coldplay", album: "Viva la Vida", year: "2008", genre: "Alternative", moods: ["hopeful","bright","building","dawn"], weight: { early_morning: 8, morning: 7, clear_sky: 7, medium_load: 6 } },

  // More ambient / electronic
  { title: "Outro", artist: "M83", album: "Hurry Up, We're Dreaming", year: "2011", genre: "Electronic", moods: ["epic","emotional","vast","triumphant"], weight: { evening: 7, clear_sky: 8, low_load: 6, weekend: 7 } },
  { title: "Dayvan Cowboy", artist: "Boards of Canada", album: "The Campfire Headphase", year: "2005", genre: "IDM", moods: ["nostalgic","warm","hazy","summer"], weight: { afternoon: 8, warm_weather: 7, clear_sky: 7, medium_load: 6 } },
  { title: "Everything In Its Right Place", artist: "Radiohead", album: "Kid A", year: "2000", genre: "Art Rock", moods: ["eerie","contemplative","digital","cold"], weight: { late_night: 7, deep_night: 7, cold_weather: 7, high_load: 7 } },
  { title: "Pyramid Song", artist: "Radiohead", album: "Amnesiac", year: "2001", genre: "Art Rock", moods: ["dreamy","sinking","contemplative","water"], weight: { deep_night: 8, rain: 8, humid: 6, low_load: 7 } },
  { title: "Porcelain", artist: "Moby", album: "Play", year: "1999", genre: "Electronic", moods: ["fragile","gentle","melancholy","dawn"], weight: { early_morning: 8, deep_night: 7, rain: 6, low_load: 7 } },
  { title: "Teardrop", artist: "Massive Attack", album: "Mezzanine", year: "1998", genre: "Trip Hop", moods: ["dark","intimate","pulsing","nocturnal"], weight: { late_night: 9, deep_night: 8, humid: 7, medium_load: 7 } },
  { title: "Paradise Circus", artist: "Massive Attack", album: "Heligoland", year: "2010", genre: "Trip Hop", moods: ["dark","sensual","slow","smoky"], weight: { late_night: 8, deep_night: 9, warm_weather: 6, low_load: 7 } },
  { title: "Roads", artist: "Portishead", album: "Dummy", year: "1994", genre: "Trip Hop", moods: ["melancholy","cinematic","raw","nocturnal"], weight: { late_night: 8, deep_night: 7, rain: 8, low_load: 7 } },
  { title: "Glory Box", artist: "Portishead", album: "Dummy", year: "1994", genre: "Trip Hop", moods: ["sensual","intimate","smoky","dark"], weight: { late_night: 8, deep_night: 8, night: 7, low_load: 7 } },
  { title: "Sleepwalking", artist: "Nujabes", album: "Spiritual State", year: "2011", genre: "Jazz Hop", moods: ["dreamy","flowing","nocturnal","peaceful"], weight: { deep_night: 8, late_night: 7, medium_load: 7, coding: 8 } },
  { title: "Feather", artist: "Nujabes", album: "Modal Soul", year: "2005", genre: "Jazz Hop", moods: ["uplifting","warm","flowing","confident"], weight: { afternoon: 8, evening: 7, clear_sky: 7, coding: 8 } },
  { title: "Aruarian Dance", artist: "Nujabes", album: "Samurai Champloo OST", year: "2004", genre: "Jazz Hop", moods: ["nostalgic","warm","sunset","gentle"], weight: { evening: 9, night: 7, warm_weather: 7, low_load: 7 } },

  // More classical / soundtrack
  { title: "Merry Christmas Mr. Lawrence", artist: "Ryuichi Sakamoto", album: "Merry Christmas Mr. Lawrence OST", year: "1983", genre: "Soundtrack", moods: ["melancholy","winter","elegant","bittersweet"], weight: { deep_night: 8, late_night: 8, cold_weather: 9, rain: 7 } },
  { title: "Solveig's Song", artist: "Edvard Grieg", album: "Peer Gynt Suite", year: "1876", genre: "Classical", moods: ["lonely","waiting","tender","cold"], weight: { deep_night: 7, cold_weather: 8, rain: 6, low_load: 7 } },
  { title: "Nocturne Op.9 No.2", artist: "Frederic Chopin", album: "Nocturnes", year: "1832", genre: "Classical", moods: ["romantic","elegant","night","flowing"], weight: { night: 9, late_night: 8, clear_sky: 7, low_load: 8 } },
  { title: "Moonlight Sonata", artist: "Ludwig van Beethoven", album: "Piano Sonata No.14", year: "1801", genre: "Classical", moods: ["dark","intense","moonlit","emotional"], weight: { deep_night: 9, late_night: 8, clear_sky: 8, low_load: 7 } },
  { title: "The Departure", artist: "Max Richter", album: "Memoryhouse", year: "2002", genre: "Neoclassical", moods: ["bittersweet","vast","emotional","farewell"], weight: { evening: 8, night: 7, cloud: 7, medium_load: 6 } },
  { title: "On the Nature of Daylight", artist: "Max Richter", album: "The Blue Notebooks", year: "2004", genre: "Neoclassical", moods: ["melancholy","vast","emotional","contemplative"], weight: { evening: 8, rain: 8, cloud: 7, low_load: 8 } },
  { title: "Summer", artist: "Joe Hisaishi", album: "Kikujiro OST", year: "1999", genre: "Soundtrack", moods: ["innocent","warm","nostalgic","playful"], weight: { morning: 8, afternoon: 8, warm_weather: 8, clear_sky: 7 } },
  { title: "One Summer's Day", artist: "Joe Hisaishi", album: "Spirited Away OST", year: "2001", genre: "Soundtrack", moods: ["nostalgic","magical","gentle","summer"], weight: { afternoon: 7, evening: 8, warm_weather: 7, low_load: 7 } },
  { title: "Merry-Go-Round of Life", artist: "Joe Hisaishi", album: "Howl's Moving Castle OST", year: "2004", genre: "Soundtrack", moods: ["whimsical","building","magical","joyful"], weight: { morning: 7, clear_sky: 7, weekend: 8, medium_load: 6 } },
];

// ── Commentary templates ────────────────────────────────────────
const COMMENTARY_TEMPLATES = {
  // Deep night (0-5am)
  deep_night: {
    rain: [
      "凌晨{time}，上海的雨还在下。{temp}度的夜里，雨声像是城市最后的低语。你的电脑还亮着，{systemNote}——也许这首歌，能让深夜的忙碌多一点温柔。",
      "雨落在{time}的上海，{temp}度的凉意透过窗缝。{systemNote}，让这首歌替我说一声：辛苦了。",
      "窗外的雨声混着{time}的寂静。上海今夜{temp}度，湿度{humidity}%，空气里都是水的味道。{systemNote}，放一首歌给还在夜里的你。",
    ],
    clear: [
      "凌晨{time}，上海的天空难得清澈。{temp}度的夜，星光大概都藏在城市的灯火背后。{systemNote}，把这首歌送给此刻清醒的你。",
      "{time}，夜色正浓。上海{temp}度，天空晴朗得像是为深夜的人留了一扇窗。{systemNote}，愿这首歌陪你度过这段安静的时光。",
      "这是属于{time}的上海。{temp}度，天清气朗。{systemNote}——有时候深夜的清醒，是另一种奢侈。这首歌，送给夜的奢侈。",
    ],
    cloudy: [
      "凌晨{time}，上海的云层低低压着。{temp}度的夜里，整个城市像被棉被裹住。{systemNote}，播一首歌，让云也听一听。",
      "{time}的上海，云雾弥漫。{temp}度，湿度{humidity}%。{systemNote}，这种夜里特别适合一首慢歌。",
    ],
    default: [
      "凌晨{time}，上海{weather}。{temp}度的深夜，城市在沉睡，你却还在。{systemNote}，这首歌送给所有深夜里发光的灵魂。",
      "{time}，上海的夜正深。{temp}度，{weather}。{systemNote}——让我们用音乐，填满这段只属于你的时间。",
    ],
  },
  // Late night (22-0)
  late_night: {
    rain: [
      "晚上{time}，上海又下雨了。{temp}度的夜，雨点敲在玻璃上像是在打节拍。{systemNote}，为你选了一首和雨声很搭的歌。",
      "上海{time}，雨夜。{temp}度，{humidity}%的湿度让空气变得柔软。{systemNote}，听首歌吧，让夜晚慢下来。",
    ],
    clear: [
      "{time}的上海，天空清透。{temp}度的夜风刚刚好。{systemNote}，送你一首适合在这个温度下聆听的歌。",
      "晚上{time}，上海的夜色真好。{temp}度，视野清晰。{systemNote}——在这个美好的夜晚，送你一首歌当作晚安前的礼物。",
    ],
    default: [
      "{time}的上海，{weather}。{temp}度的夜晚，世界正在变得安静。{systemNote}，让音乐接管剩下的时光。",
      "晚上{time}，上海{weather}，{temp}度。{systemNote}。蒸馏电台为你精心挑选了这首歌，愿它是今夜最温柔的陪伴。",
    ],
  },
  // Night (19-22)
  night: {
    default: [
      "{time}，上海的夜刚开始。{weather}，{temp}度。{systemNote}，这个时间段最适合一首不太快也不太慢的歌。",
      "晚上{time}，上海{weather}，{temp}度。{systemNote}——夜晚是属于音乐的时间，让蒸馏电台陪你。",
      "{time}的上海，{temp}度，{weather}。一天快要结束了，{systemNote}，用一首歌来收尾吧。",
    ],
  },
  // Evening (17-19)
  evening: {
    default: [
      "傍晚{time}，上海{weather}。{temp}度的黄昏，城市从白天切换到夜晚。{systemNote}，为你选了一首适合这个过渡时刻的歌。",
      "{time}的上海，暮色渐浓。{weather}，{temp}度。{systemNote}——在晚霞消散之前，听听这首歌。",
    ],
  },
  // Afternoon (14-17)
  afternoon: {
    default: [
      "下午{time}，上海{weather}，{temp}度。{systemNote}，午后的时光总是需要一点音乐来点缀。",
      "{time}的上海午后，{weather}。{temp}度的空气里，{systemNote}。来一首歌，让下午变得更有质感。",
    ],
  },
  // Morning (8-12)
  morning: {
    default: [
      "早上{time}，上海{weather}。{temp}度的清晨，新的一天。{systemNote}，用这首歌开启今天。",
      "{time}的上海早晨，{weather}，{temp}度。{systemNote}——早安，让音乐唤醒你的感官。",
    ],
  },
  // Early morning (5-8)
  early_morning: {
    default: [
      "清晨{time}，上海{weather}。{temp}度，城市正在苏醒。{systemNote}，送你一首晨曲。",
      "{time}，上海的天刚亮。{weather}，{temp}度。{systemNote}——破晓时分，万物新生，这首歌送给早起的你。",
    ],
  },
  // Noon (12-14)
  noon: {
    default: [
      "中午{time}，上海{weather}，{temp}度。{systemNote}，午间休息的时候，听首歌放松一下。",
      "{time}，上海正午。{weather}，{temp}度。{systemNote}——忙碌半天了，让音乐给你充个电。",
    ],
  },
};

// ── System state observation notes ──────────────────────────────
function getSystemNote(system) {
  const cpu = parseFloat(system.cpu_load_percent);
  const mem = parseFloat(system.mem_percent);
  const battery = system.battery_percent;
  const procs = system.top_processes.map(p => p.name).filter(Boolean);

  const notes = [];

  // CPU state
  if (cpu > 80) notes.push("你的电脑正在高速运转，CPU占用{cpu}%");
  else if (cpu > 50) notes.push("电脑还在忙碌着，CPU {cpu}%");
  else if (cpu > 20) notes.push("电脑运行得很平稳");
  else notes.push("电脑很安静，CPU几乎在休息");

  // Process observation
  const hasCoding = procs.some(p => /code|vim|nvim|idea|xcode|terminal|iterm|claude/i.test(p));
  const hasBrowser = procs.some(p => /chrome|safari|firefox|edge|arc/i.test(p));
  const hasCreative = procs.some(p => /figma|sketch|photoshop|premiere|final.cut|logic/i.test(p));
  const hasMusic = procs.some(p => /spotify|music|netease|qqmusic/i.test(p));

  if (hasCoding) notes.push("看起来你在写代码");
  else if (hasCreative) notes.push("你在做创意工作");
  else if (hasBrowser && !hasCoding) notes.push("你在浏览网页");

  // Memory pressure
  if (mem > 90) notes.push("内存已经快满了");

  // Battery
  if (typeof battery === 'number') {
    if (battery < 20 && !system.battery_charging) notes.push("电量只剩{battery}%了，记得充电");
    else if (system.battery_charging) notes.push("电脑正在充电");
  }

  // Pick 1-2 notes and format
  const selected = notes.slice(0, 2);
  let result = selected.join("，");
  result = result
    .replace("{cpu}", system.cpu_load_percent)
    .replace("{battery}", String(battery));

  return result;
}

// ── Mood analysis ───────────────────────────────────────────────
function analyzeMood(weather, system, time) {
  const tags = new Set();
  const factors = {};

  // Time-based
  factors[time.period] = 10;
  if (time.isWeekend) { factors.weekend = 3; tags.add("weekend"); }

  // Weather-based
  const desc = weather.desc.toLowerCase();
  const temp = parseFloat(weather.temp_c);
  const humidity = parseFloat(weather.humidity);
  const wind = parseFloat(weather.windspeed_kmh);
  const cloud = parseFloat(weather.cloud_cover);

  if (desc.includes("rain") || desc.includes("drizzle") || desc.includes("shower")) {
    factors.rain = 8; tags.add("rainy");
  }
  if (desc.includes("thunder") || desc.includes("storm")) {
    factors.storm = 8; tags.add("stormy");
  }
  if (desc.includes("fog") || desc.includes("mist")) {
    factors.fog = 7; tags.add("misty");
  }
  if (desc.includes("snow")) {
    factors.snow = 8; tags.add("snowy");
  }
  if (cloud < 30) { factors.clear_sky = 6; tags.add("clear"); }
  else if (cloud > 70) { factors.cloud = 5; tags.add("overcast"); }

  if (temp < 5) { factors.cold_weather = 7; tags.add("cold"); }
  else if (temp < 15) { factors.cool_weather = 5; tags.add("cool"); }
  else if (temp > 30) { factors.hot_weather = 6; tags.add("warm"); }
  else if (temp > 20) { factors.warm_weather = 4; tags.add("mild"); }

  if (humidity > 80) { factors.humid = 4; }
  if (wind > 30) { factors.windy = 5; tags.add("windy"); }

  // System-based
  const cpu = parseFloat(system.cpu_load_percent);
  if (cpu > 70) { factors.high_load = 6; tags.add("busy"); }
  else if (cpu > 35) { factors.medium_load = 4; tags.add("working"); }
  else { factors.low_load = 5; tags.add("calm"); }

  if (system.battery_charging) { factors.charging = 3; }

  const procs = system.top_processes.map(p => p.name).filter(Boolean);
  if (procs.some(p => /code|vim|nvim|idea|xcode|claude/i.test(p))) {
    factors.coding = 5; tags.add("focused");
  }

  return { factors, tags: [...tags].slice(0, 3) };
}

// ── Song scorer ─────────────────────────────────────────────────
let recentIndices = [];

function scoreSong(song, index, factors) {
  let score = 0;
  const w = song.weight;
  for (const [key, value] of Object.entries(factors)) {
    if (w[key]) score += w[key] * value;
  }
  // Penalize recently played
  if (recentIndices.includes(index)) score -= 1000;
  // Add small random factor for variety
  score += Math.random() * 15;
  return score;
}

function pickSong(factors) {
  let bestIdx = 0;
  let bestScore = -Infinity;
  SONGS.forEach((song, i) => {
    const s = scoreSong(song, i, factors);
    if (s > bestScore) { bestScore = s; bestIdx = i; }
  });
  recentIndices.push(bestIdx);
  if (recentIndices.length > 15) recentIndices.shift();
  return SONGS[bestIdx];
}

// ── Commentary generator ────────────────────────────────────────
function generateCommentary(weather, system, time) {
  const period = time.period;
  const desc = weather.desc.toLowerCase();
  const templates = COMMENTARY_TEMPLATES[period] || COMMENTARY_TEMPLATES.night;

  let weatherKey = "default";
  if (desc.includes("rain") || desc.includes("drizzle") || desc.includes("shower")) weatherKey = "rain";
  else if (desc.includes("clear") || desc.includes("sunny")) weatherKey = "clear";
  else if (desc.includes("cloud") || desc.includes("overcast")) weatherKey = "cloudy";

  const pool = templates[weatherKey] || templates.default || templates[Object.keys(templates)[0]];
  const template = pool[Math.floor(Math.random() * pool.length)];

  const systemNote = getSystemNote(system);

  return template
    .replace(/{time}/g, time.formatted)
    .replace(/{temp}/g, weather.temp_c)
    .replace(/{humidity}/g, weather.humidity)
    .replace(/{weather}/g, weather.desc)
    .replace(/{systemNote}/g, systemNote);
}

// ── Reason generator ────────────────────────────────────────────
function generateReason(song, weather, time) {
  const mood = song.moods[0];
  const period = time.period;
  const temp = parseFloat(weather.temp_c);
  const desc = weather.desc.toLowerCase();

  const reasons = [];

  // Time-based reasons
  if (period === "deep_night") reasons.push("凌晨的寂静需要这样温柔的声音来填满", "深夜最适合这种安静的旋律");
  if (period === "late_night") reasons.push("夜晚渐深，这首歌的节奏刚好能让人放松", "临近午夜，需要一首歌来安放情绪");
  if (period === "early_morning") reasons.push("清晨需要这样轻柔的旋律来唤醒", "黎明时分，用音乐迎接新的一天");
  if (period === "evening") reasons.push("黄昏时分，这首歌像是为此刻量身定做", "傍晚的过渡时刻，需要这样的歌");

  // Weather-based reasons
  if (desc.includes("rain")) reasons.push("雨天和这首歌简直是绝配", "窗外的雨声会成为最好的伴奏");
  if (temp < 10) reasons.push("冷夜里需要一首温暖的歌", "低温的夜晚，让音乐带来一点温度");
  if (temp > 28) reasons.push("闷热的夜里需要一点清凉的声音");

  // Mood-based reasons
  if (mood === "serene" || mood === "calm") reasons.push("此刻你需要的，是一片宁静");
  if (mood === "melancholy") reasons.push("有时候，一点忧郁也是一种享受");
  if (mood === "nostalgic") reasons.push("让旋律带你回到某个温暖的记忆里");
  if (mood === "intimate") reasons.push("深夜适合亲密的声音");
  if (mood === "dreamy") reasons.push("让思绪随着旋律飘远");

  return reasons.length > 0
    ? reasons[Math.floor(Math.random() * reasons.length)]
    : `${song.genre}的氛围很适合此刻的心境`;
}

// ── Main generation function ────────────────────────────────────
async function generateRadioContent(weather, system, time) {
  const { factors, tags } = analyzeMood(weather, system, time);
  const song = pickSong(factors);
  const commentary = generateCommentary(weather, system, time);
  const reason = generateReason(song, weather, time);
  const youtubeId = await resolveYouTubeId(song.title, song.artist);

  return {
    commentary,
    song: {
      title: song.title,
      artist: song.artist,
      album: song.album,
      year: song.year,
      genre: song.genre,
      mood: song.moods[0],
      reason,
      youtubeId,
    },
    ambient_tags: tags,
  };
}

// ── API Routes ──────────────────────────────────────────────────
app.get("/api/context", async (req, res) => {
  try {
    const [weather, system] = await Promise.all([getWeather(), getSystemStats()]);
    const time = getTimeContext();
    res.json({ weather, system, time });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/radio", async (req, res) => {
  try {
    const [weather, system] = await Promise.all([getWeather(), getSystemStats()]);
    const time = getTimeContext();
    const radio = await generateRadioContent(weather, system, time);
    res.json({ weather, system, time, radio });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── YouTube search (multi-result, for direct user search) ─────────
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "q is required" });
  if (q.length > 120) return res.status(400).json({ error: "query too long" });

  const ip = clientIp(req);
  const key = q.toLowerCase();
  const now = Date.now();

  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > now) {
    return res.json({ items: cached.items, cached: true });
  }

  if (searchRateLimited(ip)) {
    return res.status(429).json({ error: "Too many searches, slow down a bit." });
  }

  try {
    const results = await YouTube.default.search(q, { limit: 12, type: "video" });
    const items = (results || []).map((r) => ({
      videoId: r.id,
      title: r.title || "",
      channel: r.channel?.name || "",
      durationMs: r.duration || 0,
      durationText: r.durationFormatted || "",
      thumbnail:
        r.thumbnail?.url ||
        (r.id ? `https://i.ytimg.com/vi/${r.id}/hqdefault.jpg` : ""),
      views: r.views || 0,
    })).filter((x) => x.videoId);

    searchCache.set(key, { items, expiresAt: now + SEARCH_TTL_MS });
    if (searchCache.size > 500) {
      // crude size cap: drop oldest 100 entries
      const entries = [...searchCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (let i = 0; i < 100; i++) searchCache.delete(entries[i][0]);
    }
    res.json({ items, cached: false });
  } catch (e) {
    console.error("Search failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── YouTube helper endpoints ───────────────────────────────────────
app.get("/api/youtube-id", async (req, res) => {
  const { title, artist } = req.query;
  if (!title || !artist)
    return res.status(400).json({ error: "title and artist required" });
  // Use alt query mode to try different search patterns
  const youtubeId = await resolveYouTubeId(title, artist, true);
  res.json({ youtubeId });
});

// Throttle bad-cache clears: stops the front-end from spamming us into a
// "clear → re-resolve → still blocked → clear again" loop that hammers youtube-sr.
const lastBadClearAt = new Map();
const BAD_CLEAR_COOLDOWN_MS = 5 * 60 * 1000;

app.post("/api/youtube-error", (req, res) => {
  const { title, artist, errorCode } = req.body || {};
  if (!title || !artist) return res.json({ ok: true });
  const key = `${title} - ${artist}`;
  const now = Date.now();
  const last = lastBadClearAt.get(key) || 0;

  if (
    youtubeCache[key] &&
    [2, 100, 101, 150].includes(errorCode) &&
    now - last >= BAD_CLEAR_COOLDOWN_MS
  ) {
    delete youtubeCache[key];
    saveCache();
    lastBadClearAt.set(key, now);
    console.log(`  ✗ Cleared bad cache: ${key} (error ${errorCode})`);
  }
  res.json({ ok: true });
});

app.get("/api/warm-cache", async (req, res) => {
  const results = { resolved: 0, failed: 0, cached: 0, total: SONGS.length };
  for (const song of SONGS) {
    const key = `${song.title} - ${song.artist}`;
    if (youtubeCache[key]) {
      results.cached++;
      continue;
    }
    const id = await resolveYouTubeId(song.title, song.artist);
    id ? results.resolved++ : results.failed++;
    await new Promise((r) => setTimeout(r, 2000)); // rate limit - 2s between searches
  }
  res.json(results);
});

// ── TTS endpoints ──────────────────────────────────────────────────
app.get("/api/tts/voices", (req, res) => {
  res.json({ voices: TTS_VOICES });
});

app.post("/api/tts", async (req, res) => {
  const { text, voice = "zh-CN-XiaoxiaoNeural" } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-cache");

    audioStream.pipe(res);

    audioStream.on("error", (err) => {
      console.error("TTS stream error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "TTS generation failed" });
      } else {
        res.end();
      }
    });
  } catch (e) {
    console.error("TTS error:", e.message);
    res.status(500).json({ error: "TTS generation failed: " + e.message });
  }
});

// ── DeepSeek / LLM endpoints ───────────────────────────────────────
app.post("/api/set-config", (req, res) => {
  const { deepseekKey } = req.body;
  const ip = clientIp(req);
  if (deepseekKey) {
    if (typeof deepseekKey !== "string" || deepseekKey.length > 200) {
      return res.status(400).json({ error: "invalid key" });
    }
    deepseekKeysByIp.set(ip, deepseekKey);
    console.log(`  DeepSeek API key configured for ${ip}`);
  } else {
    deepseekKeysByIp.delete(ip);
  }
  res.json({ ok: true, hasKey: !!getDeepSeekKey(req) });
});

app.get("/api/config-status", (req, res) => {
  res.json({ hasDeepSeekKey: !!getDeepSeekKey(req) });
});

app.post("/api/request-song", async (req, res) => {
  const { instruction } = req.body;
  if (!instruction) return res.status(400).json({ error: "instruction is required" });

  const client = getDeepSeekClient(req);
  if (!client) {
    return res.status(400).json({ error: "DeepSeek API key not configured. Please set it in settings." });
  }

  try {
    const [weather, system] = await Promise.all([getWeather(), getSystemStats()]);
    const time = getTimeContext();

    // Ask DeepSeek to parse the instruction
    const allMoods = [...new Set(SONGS.flatMap(s => s.moods))];
    const allGenres = [...new Set(SONGS.map(s => s.genre))];
    const allArtists = [...new Set(SONGS.map(s => s.artist))];

    const completion = await client.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content: `你是蒸馏电台的 DJ 助手。根据用户的点歌请求，分析其意图并返回 JSON。

可选 moods: ${allMoods.join(", ")}
可选 genres: ${allGenres.join(", ")}
可选 artists: ${allArtists.join(", ")}

返回格式：
{
  "moods": ["mood1", "mood2"],
  "genres": ["genre1"],
  "artists": ["artist1"],
  "commentary": "一句回应用户请求的 DJ 话术，中文，30-60字，温暖文艺风格"
}

如果用户的请求比较模糊，根据语境推断最合适的 moods。只从上面列出的选项中选择。`
        },
        {
          role: "user",
          content: instruction
        }
      ],
      temperature: 0.7,
      max_tokens: 300,
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const { moods = [], genres = [], artists = [], commentary: llmCommentary } = parsed;

    // Score songs based on LLM preferences
    let bestSong = null;
    let bestScore = -Infinity;

    SONGS.forEach((song, i) => {
      if (recentIndices.includes(i)) return;
      let score = 0;

      // Mood matching
      for (const m of moods) {
        if (song.moods.includes(m)) score += 20;
      }
      // Genre matching
      for (const g of genres) {
        if (song.genre.toLowerCase().includes(g.toLowerCase())) score += 15;
      }
      // Artist matching
      for (const a of artists) {
        if (song.artist.toLowerCase().includes(a.toLowerCase())) score += 30;
      }
      // Add some randomness
      score += Math.random() * 5;

      if (score > bestScore) {
        bestScore = score;
        bestSong = song;
      }
    });

    if (!bestSong) bestSong = SONGS[Math.floor(Math.random() * SONGS.length)];

    // Track as recently played
    const idx = SONGS.indexOf(bestSong);
    if (idx >= 0) {
      recentIndices.push(idx);
      if (recentIndices.length > 15) recentIndices.shift();
    }

    const youtubeId = await resolveYouTubeId(bestSong.title, bestSong.artist);

    // Generate DJ commentary that responds to the user's request
    const djCommentary = llmCommentary ||
      `你说"${instruction}"——好的，蒸馏电台收到。这首${bestSong.title}，希望是你此刻想要的声音。`;

    const { tags } = analyzeMood(weather, system, time);

    res.json({
      weather, system, time,
      radio: {
        commentary: djCommentary,
        song: {
          title: bestSong.title,
          artist: bestSong.artist,
          album: bestSong.album,
          year: bestSong.year,
          genre: bestSong.genre,
          mood: bestSong.moods[0],
          reason: `因为你说"${instruction}"`,
          youtubeId,
        },
        ambient_tags: tags,
      },
      userRequested: true,
    });
  } catch (e) {
    console.error("Request-song error:", e.message);
    res.status(500).json({ error: "Failed to process request: " + e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   蒸 馏 电 台  Distillery Radio      ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  if (PUBLIC_URL) {
    console.log(`  ║   public: ${PUBLIC_URL.padEnd(27).slice(0, 27)}║`);
  }
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
