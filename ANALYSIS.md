# Distillery Radio - Complete Architecture Analysis

## 1. SONG DATABASE STRUCTURE (src/server.js, lines 100-177)

### Song Object Format
Each song in the SONGS array (lines 101-177) contains:
```javascript
{
  title: string,
  artist: string,
  album: string,
  year: string,
  genre: string,
  moods: string[], // e.g., ["serene","melancholy","night","rainy","quiet"]
  weight: {
    // Contextual weight factors that affect selection
    [factor]: number, // factors like: deep_night, late_night, rain, low_load, etc.
  }
}
```

**KEY FINDING**: Songs do NOT have YouTube video IDs. This is crucial for YouTube integration.

### Weight Factors
Songs are weighted by various factors:
- **Time periods**: deep_night (0-5am), late_night (22-0), night (19-22), evening (17-19), afternoon (14-17), morning (8-12), early_morning (5-8), noon (12-14)
- **Weather**: rain, storm, fog, snow, clear_sky, cloud, cold_weather, cool_weather, hot_weather, warm_weather, humid, windy
- **System load**: high_load (cpu > 70%), medium_load (cpu > 35%), low_load
- **Other**: weekend, charging, coding

### Example Song (line 103)
```javascript
{ 
  title: "Gymnopdie No.1", 
  artist: "Erik Satie", 
  album: "Gymnopedies", 
  year: "1888", 
  genre: "Classical", 
  moods: ["serene","melancholy","night","rainy","quiet"], 
  weight: { 
    deep_night: 9, late_night: 8, rain: 7, low_load: 8 
  } 
}
```

---

## 2. SONG PICKING ALGORITHM (src/server.js, lines 361-387)

### Recent History Tracking
- **Line 362**: `let recentIndices = []` - Keeps track of last ~15 played songs
- **Line 371**: Recently played songs are penalized with `-1000` score

### Score Calculation (lines 364-375)
```javascript
function scoreSong(song, index, factors) {
  let score = 0;
  const w = song.weight;
  // Sum: weight[factor] * factor_value for each matching factor
  for (const [key, value] of Object.entries(factors)) {
    if (w[key]) score += w[key] * value;
  }
  if (recentIndices.includes(index)) score -= 1000; // Avoid repeats
  score += Math.random() * 15; // Add randomness for variety
  return score;
}
```

### Song Selection (lines 377-387)
```javascript
function pickSong(factors) {
  let bestIdx = 0;
  let bestScore = -Infinity;
  SONGS.forEach((song, i) => {
    const s = scoreSong(song, i, factors);
    if (s > bestScore) { bestScore = s; bestIdx = i; }
  });
  recentIndices.push(bestIdx);
  if (recentIndices.length > 15) recentIndices.shift(); // Keep only last 15
  return SONGS[bestIdx];
}
```

---

## 3. /api/radio ENDPOINT (src/server.js, lines 478-487)

### Response Structure
```javascript
GET /api/radio
{
  weather: { temp_c, feelslike_c, humidity, desc, windspeed_kmh, cloud_cover, uv_index, visibility, pressure },
  system: { cpu_brand, cpu_load_percent, mem_used_gb, mem_total_gb, mem_percent, battery_percent, battery_charging, process_count, top_processes },
  time: { hour, minute, period, dayOfWeek, formatted, isWeekend },
  radio: {
    commentary: string, // Long contextual narrative in Chinese
    song: {
      title: string,
      artist: string,
      album: string,
      year: string,
      genre: string,
      mood: string,
      reason: string, // Why this song fits the current context
    },
    ambient_tags: string[], // 3 tags describing the mood/context
  }
}
```

---

## 4. PUBLIC/INDEX.HTML - JAVASCRIPT STRUCTURE

### State Object (lines 752-759)
```javascript
const state = {
  playing: false,        // Play/pause state
  autoMode: true,       // Auto-advance enabled?
  autoInterval: 180,    // Seconds between tracks (3 minutes)
  countdown: 0,         // Seconds remaining until next track
  currentData: null,    // Last fetched radio content
  loading: false,       // Fetch in progress?
};
```

### DOM Element References (lines 762-778)
Key IDs used:
- `vinyl` - Rotating vinyl record (id="vinyl")
- `tonearm` - Tonearm element (id="tonearm")
- `on-air` - On-air indicator (id="on-air")
- `btn-play` - Play/pause button (id="btn-play")
- `btn-skip` - Skip button (id="btn-skip")
- `btn-auto` - Auto-mode toggle (id="btn-auto")
- `song-title` - Song title display (id="song-title")
- `song-artist` - Artist name (id="song-artist")
- `song-meta` - Album, year, genre (id="song-meta")
- `commentary-text` - DJ commentary typewriter text (id="commentary-text")
- `commentary-card` - Commentary card container (id="commentary-card")
- `reason-text` - "Why this song" explanation (id="reason-text")
- `countdown` - Timer display (id="countdown")
- `ambient-tags` - Context tags container (id="ambient-tags")
- `waveform` - Waveform container (id="waveform")
- `volume` - Volume slider input (id="volume")

---

## 5. WAVEFORM ANIMATION (lines 780-804)

### Waveform Bar Creation (lines 781-788)
- Creates 64 bars (BAR_COUNT = 64)
- Each bar: `<div class="wave-bar">` with initial height: 4px

### Animation Loop (lines 790-804)
```javascript
function animateWaveform() {
  waveBars.forEach((bar, i) => {
    if (state.playing) {
      // PLAYING STATE: Animated, energetic bars
      const h = 4 + Math.random() * 36 * 
                (0.5 + 0.5 * Math.sin(Date.now() / 400 + i * 0.3));
      bar.style.height = h + 'px';
      bar.classList.add('active');
    } else {
      // PAUSED STATE: Gentle, minimal animation
      const h = 3 + Math.sin(Date.now() / 2000 + i * 0.2) * 2;
      bar.style.height = h + 'px';
      bar.classList.remove('active');
    }
  });
  requestAnimationFrame(animateWaveform);
}
```

**Animation Parameters**:
- Playing: Random height 4-40px, updates every ~400ms, has 'active' class (opacity 0.9)
- Paused: Gentle wave 1-5px, updates every ~2000ms, opacity 0.5
- Runs continuously via requestAnimationFrame

---

## 6. FETCH RADIO FUNCTION (lines 879-939)

### Main Flow
```javascript
async function fetchRadio() {
  // 1. Check loading state (line 880-881)
  if (state.loading) return;
  state.loading = true;

  // 2. Dim current content (lines 883-885)
  songTitle.style.opacity = '0.3';
  commentaryText.classList.remove('visible');

  // 3. Fetch /api/radio (lines 888-889)
  const res = await fetch('/api/radio');
  const data = await res.json();
  state.currentData = data;

  // 4. Update context chips (lines 892-893)
  updateContext(data);

  // 5. Update song info with fade (lines 898-903)
  setTimeout(() => {
    songTitle.textContent = radio.song.title;
    songTitle.style.opacity = '1';
    songArtist.textContent = radio.song.artist;
    songMeta.textContent = `${radio.song.album} · ${radio.song.year} · ${radio.song.genre}`;
  }, 300);

  // 6. Typewriter DJ commentary (lines 906-908)
  setTimeout(() => {
    typewriter(commentaryText, radio.commentary, 60);
  }, 800);

  // 7. Add glow effect (lines 911-912)
  commentaryCard.classList.add('glow');
  setTimeout(() => commentaryCard.classList.remove('glow'), 3000);

  // 8. Update reason text (line 915)
  reasonText.textContent = radio.song.reason;

  // 9. Update ambient tags (lines 918-924)
  ambientTags.innerHTML = '';
  (radio.ambient_tags || []).forEach(tag => {
    const el = document.createElement('span');
    el.className = 'ambient-tag';
    el.textContent = tag;
    ambientTags.appendChild(el);
  });

  // 10. Start playing if not already (lines 927)
  if (!state.playing) togglePlay();

  // 11. Reset countdown to 180s (line 930)
  state.countdown = state.autoInterval;
}
```

### UI Update Timeline
1. **T+0ms**: Dim song title, hide commentary
2. **T+300ms**: Show new song info with fade-in
3. **T+800ms**: Start typewriter effect on commentary (60ms per char)
4. **T+3000ms**: Remove glow effect from card

---

## 7. PLAY/PAUSE TOGGLE (lines 942-948)

```javascript
function togglePlay() {
  state.playing = !state.playing;
  vinyl.classList.toggle('spinning', state.playing);    // CSS animation on/off
  tonearm.classList.toggle('playing', state.playing);   // Tonearm rotation
  onAir.classList.toggle('active', state.playing);      // Red on-air indicator
  btnPlay.innerHTML = state.playing ? '&#10074;&#10074;' : '&#9654;'; // ▶ vs ⏸
}
```

### CSS Classes (public/index.html)
- **`.spinning` class (line 203-204)**: Applies `animation: spin 8s linear infinite` to vinyl
- **`.playing` class on tonearm (line 276-278)**: Changes `transform: rotate(8deg)` from `rotate(25deg)`
- **`.active` class on on-air (line 118-122)**: Adds glow and pulse animation

---

## 8. AUTO-MODE COUNTDOWN (lines 951-963)

```javascript
function tickCountdown() {
  if (state.playing && state.autoMode && state.countdown > 0) {
    state.countdown--;
    const m = Math.floor(state.countdown / 60);
    const s = state.countdown % 60;
    countdownEl.textContent = `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    
    if (state.countdown <= 0) {
      fetchRadio(); // Auto-fetch next track
    }
  }
}

setInterval(tickCountdown, 1000); // Runs every second
```

**Countdown Logic**:
- Only ticks when: playing AND autoMode AND countdown > 0
- Decrements every 1 second
- Displays in MM:SS format
- When reaches 0, automatically calls fetchRadio()

---

## 9. BUTTON EVENT HANDLERS (lines 966-981)

### Play Button (lines 966)
```javascript
btnPlay.addEventListener('click', togglePlay);
```

### Skip Button (lines 968-971)
```javascript
btnSkip.addEventListener('click', () => {
  state.countdown = 0;     // Force countdown to 0
  fetchRadio();            // Immediately fetch next track
});
```

### Auto Mode Toggle (lines 973-977)
```javascript
btnAuto.addEventListener('click', () => {
  state.autoMode = !state.autoMode;
  btnAuto.style.color = state.autoMode ? 'var(--accent)' : 'var(--text-dim)';
  btnAuto.style.borderColor = state.autoMode ? 'var(--accent)' : 'var(--border)';
});
```

**Auto Mode Styling**:
- Active: accent color (#c4956a) with golden glow
- Inactive: dimmed text color

---

## 10. VOLUME SLIDER (HTML lines 710-713)

```html
<input type="range" class="volume-slider" id="volume" min="0" max="100" value="70" />
```

**Current Status**: Pure HTML slider with CSS styling
- No JavaScript event handler
- No actual audio playback connected
- Value changes are visual only

---

## 11. BOOT SEQUENCE (lines 984-995)

```javascript
async function boot() {
  // Show loading for atmosphere (line 986)
  await new Promise(r => setTimeout(r, 1500));

  // Fetch first radio content (line 989)
  await fetchRadio();

  // Hide loading overlay (line 992)
  loadingOverlay.classList.add('hidden');
}

boot();
```

**Startup Timeline**:
1. Load page → show loading overlay
2. Wait 1.5 seconds
3. Fetch first radio content
4. Hide loading overlay
5. Auto-start playing

---

## 12. PLAYBACK SIMULATION (Current Behavior)

### What Actually Happens
1. **Vinyl spins**: CSS `animation: spin 8s linear infinite` (line 204)
   - Continuous 360° rotation every 8 seconds
   - No sync with audio duration
   - No pause/resume sync

2. **Waveform animates**: JavaScript loop calculates random heights (lines 790-804)
   - No connection to actual audio data
   - Purely visual
   - Synced to internal `state.playing` flag

3. **Tonearm moves**: CSS transition on `.playing` class (line 251)
   - Smooth rotation from 25° to 8° when playing
   - No audio playback

4. **No actual audio playback**:
   - Volume slider is not connected to anything
   - Countdown timer auto-advances regardless
   - No audio context or Web Audio API
   - No media elements (`<audio>` tags)

---

## 13. CHANGES NEEDED FOR YOUTUBE IFRAME API

### SONG DATABASE
- **Add YouTube ID field** to each song object:
  ```javascript
  { 
    ..., 
    youtubeId: "dQw4w9WgXcQ",  // ADD THIS
    duration: 212, // in seconds - ADD THIS
    ...
  }
  ```
- OR: Create a mapping file: `songs.json` with `{ title, artist, youtubeId, duration }`

### SERVER CHANGES
- Add YouTube IDs to API response:
  ```javascript
  song: {
    title, artist, album, year, genre, mood, reason,
    youtubeId: "...",  // ADD THIS
    duration: 212      // ADD THIS
  }
  ```

### CLIENT CHANGES
1. **Add YouTube IFrame API** to `<head>`:
   ```html
   <script async defer src="https://www.youtube.com/iframe_api"></script>
   ```

2. **Create player container** (HTML):
   ```html
   <div id="youtube-player" style="display:none;"></div>
   ```

3. **Initialize player** in JavaScript:
   ```javascript
   let player;
   function onYouTubeIframeAPIReady() {
     player = new YT.Player('youtube-player', {
       height: '0', width: '0',
       events: { onReady, onStateChange }
     });
   }
   ```

4. **Connect play/pause**:
   ```javascript
   function togglePlay() {
     state.playing = !state.playing;
     if (state.playing) {
       player.playVideo();
     } else {
       player.pauseVideo();
     }
     // ... update UI ...
   }
   ```

5. **Sync countdown to actual duration**:
   ```javascript
   // In fetchRadio():
   if (state.currentData.radio.duration) {
     state.countdown = state.currentData.radio.duration + 10; // Add buffer
   }
   ```

6. **Update waveform** with real audio data:
   - Use Web Audio API to analyze YT player
   - Or: Use YouTube API's `getVideoData()` and estimate

---

## KEY LINE NUMBERS REFERENCE

| Feature | File | Lines |
|---------|------|-------|
| Song database | server.js | 101-177 |
| Song scoring | server.js | 364-375 |
| Song picking | server.js | 377-387 |
| /api/radio endpoint | server.js | 478-487 |
| State object | index.html | 752-759 |
| DOM references | index.html | 762-778 |
| Waveform creation | index.html | 781-788 |
| Waveform animation | index.html | 790-804 |
| fetchRadio() | index.html | 879-939 |
| togglePlay() | index.html | 942-948 |
| Countdown timer | index.html | 951-963 |
| Button handlers | index.html | 966-981 |
| Volume slider | index.html | 710-713 |
| Boot sequence | index.html | 984-995 |
| CSS spinner | index.html | 203-204 |
| CSS tonearm | index.html | 276-278 |

---

## CURRENT ARCHITECTURE SUMMARY

```
┌─────────────────────────────────────────────┐
│        DISTILLERY RADIO - ARCHITECTURE      │
└─────────────────────────────────────────────┘

SERVER (Node.js/Express)
├─ GET /api/radio
│  ├─ Fetch weather (Shanghai, wttr.in API)
│  ├─ Get system stats (CPU, memory, battery)
│  ├─ Get time context (Shanghai timezone)
│  ├─ Analyze mood (weather + system + time)
│  ├─ Pick best-matching song from SONGS array
│  ├─ Generate DJ commentary (Chinese, contextual)
│  ├─ Generate "Why this song" reason
│  └─ Return: { weather, system, time, radio }
│
└─ SONGS array (77 songs, no YouTube IDs)
   └─ Each song: title, artist, album, year, genre, moods[], weight{}

CLIENT (Browser)
├─ fetchRadio()
│  ├─ Calls GET /api/radio
│  ├─ Updates all UI elements
│  ├─ Typewriter effect on commentary (60ms/char)
│  ├─ Glows commentary card
│  ├─ Resets countdown to 180s
│  └─ Auto-plays if not already playing
│
├─ togglePlay()
│  ├─ Toggles CSS classes on vinyl, tonearm, on-air
│  ├─ Changes button icon (▶ ↔ ⏸)
│  └─ Updates state.playing flag
│
├─ tickCountdown() [runs every 1s]
│  ├─ Decrements state.countdown
│  ├─ Updates countdown display
│  └─ Calls fetchRadio() when countdown reaches 0
│
├─ animateWaveform() [requestAnimationFrame]
│  ├─ Calculates random/wave heights for 64 bars
│  ├─ Different behavior for playing vs paused state
│  └─ NO connection to actual audio
│
└─ UI Elements
   ├─ Spinning vinyl (CSS animation: 8s per rotation)
   ├─ Tonearm (CSS transition: 25° → 8° when playing)
   ├─ On-air indicator (pulse animation when playing)
   ├─ Waveform (64 animated bars)
   ├─ Song info (title, artist, meta)
   ├─ DJ commentary (typewriter effect)
   ├─ Reason text (why this song)
   ├─ Ambient tags (mood/context)
   ├─ Control buttons (play/pause, skip, auto-mode)
   └─ Volume slider (NOT CONNECTED - visual only)

⚠️  NO ACTUAL AUDIO PLAYBACK
    ↳ No <audio> tags
    ↳ No YouTube integration
    ↳ No Web Audio API
    ↳ Everything is pure CSS animation + visual feedback
```

