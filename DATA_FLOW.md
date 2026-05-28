╔════════════════════════════════════════════════════════════════════════════╗
║                       DISTILLERY RADIO - DATA FLOW                         ║
╚════════════════════════════════════════════════════════════════════════════╝

┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. INITIAL PAGE LOAD                                                        │
└─────────────────────────────────────────────────────────────────────────────┘

   HTML loads
      ↓
   JavaScript executes (lines 750-1005)
      ↓
   state = { playing: false, autoMode: true, countdown: 0, ... }
      ↓
   Show loading overlay (loadingOverlay visible)
      ↓
   boot() function starts (line 984)
      ├─ Wait 1.5 seconds
      └─ Call fetchRadio()


┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. FETCH RADIO - SERVER SIDE (GET /api/radio)                              │
└─────────────────────────────────────────────────────────────────────────────┘

   Parallel fetches (line 480):
   ├─ getWeather()          → { temp_c, humidity, desc, windspeed, ... }
   ├─ getSystemStats()      → { cpu_load_percent, mem_percent, battery, ... }
   └─ getTimeContext()      → { period, hour, isWeekend, ... }
   
   Then:
   ├─ analyzeMood(weather, system, time)
   │  └─ Creates factors object:
   │     { deep_night: 10, rain: 8, high_load: 6, ... }
   │
   ├─ pickSong(factors)  [line 377]
   │  ├─ For each SONGS[i]:
   │  │  └─ scoreSong(song, i, factors)
   │  │     └─ score = Σ(weight[key] * factors[key]) - 1000(if_recent) + random(15)
   │  │
   │  ├─ Select song with highest score
   │  ├─ Add index to recentIndices (keep last 15)
   │  └─ Return song object
   │
   ├─ generateCommentary(weather, system, time)
   │  └─ Select random template from COMMENTARY_TEMPLATES[period]
   │     └─ Replace {time}, {temp}, {systemNote}, etc.
   │
   └─ generateReason(song, weather, time)
      └─ Select random reason matching song.moods[0]
   
   Response (line 451-464):
   {
     weather: { temp_c, humidity, desc, ... },
     system: { cpu_load_percent, battery_percent, ... },
     time: { period, formatted, ... },
     radio: {
       commentary: "凌晨3:45，上海的雨还在下...",
       song: {
         title: "Gymnopdie No.1",
         artist: "Erik Satie",
         album: "Gymnopedies",
         year: "1888",
         genre: "Classical",
         mood: "serene",
         reason: "凌晨的寂静需要这样温柔的声音来填满"
       },
       ambient_tags: ["rainy", "calm", "night"]
     }
   }


┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. FETCH RADIO - CLIENT SIDE (fetchRadio function, line 879)               │
└─────────────────────────────────────────────────────────────────────────────┘

   state.loading = true
   
   T+0ms:
   ├─ Dim song title: opacity = 0.3
   └─ Hide commentary: remove 'visible' class
   
   T+0ms: Send GET /api/radio
   
   T+0ms: (async wait for response...)
   
   T+300ms:
   ├─ Update songTitle.textContent with new title
   ├─ Update songArtist.textContent with new artist
   ├─ Update songMeta.textContent with "Album · Year · Genre"
   └─ Fade in: opacity = 1
   
   T+800ms:
   └─ Start typewriter effect on commentary (60ms per character)
   
   T+800ms to T+800ms+(length*60):
   └─ Character-by-character typing animation
   
   T+800ms:
   ├─ commentaryCard.classList.add('glow')
   └─ (apply golden border + box-shadow)
   
   T+3000ms:
   └─ commentaryCard.classList.remove('glow')
   
   Throughout:
   ├─ Update reasonText.textContent with reason
   ├─ Regenerate ambient-tags from radio.ambient_tags
   ├─ Update context chips (weather, temp, time, cpu, battery)
   └─ If not playing: call togglePlay()
   
   Finally:
   └─ state.countdown = 180 (3 minutes)
   
   state.loading = false


┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. PLAY/PAUSE TOGGLE (togglePlay function, line 942)                       │
└─────────────────────────────────────────────────────────────────────────────┘

   User clicks btnPlay
      ↓
   togglePlay() executes
      ├─ state.playing = !state.playing
      │
      ├─ vinyl.classList.toggle('spinning', state.playing)
      │  ├─ If playing: add class
      │  │  └─ CSS: animation: spin 8s linear infinite
      │  │     └─ Vinyl rotates 360° every 8 seconds
      │  │
      │  └─ If paused: remove class
      │     └─ Vinyl stops rotating
      │
      ├─ tonearm.classList.toggle('playing', state.playing)
      │  ├─ If playing: add class
      │  │  └─ CSS: transform: rotate(8deg)
      │  │
      │  └─ If paused: remove class
      │     └─ CSS: transform: rotate(25deg) [default]
      │
      ├─ onAir.classList.toggle('active', state.playing)
      │  ├─ If playing: add class
      │  │  └─ CSS: border-color: var(--red-glow)
      │  │     └─ Red indicator pulses (pulse-dot animation)
      │  │
      │  └─ If paused: remove class
      │     └─ CSS: border-color: var(--red-dim)
      │
      └─ btnPlay.innerHTML = state.playing ? '⏸⏸' : '▶'


┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. COUNTDOWN TIMER (tickCountdown function, line 951)                      │
└─────────────────────────────────────────────────────────────────────────────┘

   Every 1 second (setInterval, line 963):
   
   Check: if (state.playing && state.autoMode && state.countdown > 0)
   
   If true:
   ├─ state.countdown--
   │
   ├─ Calculate minutes and seconds
   │  ├─ m = Math.floor(state.countdown / 60)
   │  └─ s = state.countdown % 60
   │
   ├─ Update countdownEl.textContent = "m:ss"
   │
   └─ If state.countdown <= 0:
      └─ fetchRadio()  ← Loop back to step 2!
   
   If false: (paused or autoMode off or countdown already 0)
   └─ Do nothing


┌─────────────────────────────────────────────────────────────────────────────┐
│ 6. WAVEFORM ANIMATION (animateWaveform function, line 790)                 │
└─────────────────────────────────────────────────────────────────────────────┘

   Continuous requestAnimationFrame loop:
   
   For each of 64 waveBars:
   │
   ├─ If state.playing:
   │  │
   │  ├─ Calculate height:
   │  │  └─ h = 4 + Math.random() * 36 * (0.5 + 0.5 * Math.sin(Date.now() / 400 + i * 0.3))
   │  │     └─ Range: 4px to 40px
   │  │     └─ Updates every ~400ms due to Date.now() frequency
   │  │
   │  ├─ bar.style.height = h + 'px'
   │  │
   │  └─ bar.classList.add('active')  ← opacity becomes 0.9 (CSS)
   │
   └─ If NOT playing:
      │
      ├─ Calculate height (gentle wave):
      │  └─ h = 3 + Math.sin(Date.now() / 2000 + i * 0.2) * 2
      │     └─ Range: 1px to 5px
      │     └─ Updates every ~2000ms (slower)
      │
      ├─ bar.style.height = h + 'px'
      │
      └─ bar.classList.remove('active')  ← opacity becomes 0.5 (CSS)
   
   requestAnimationFrame(animateWaveform) ← Loop continues


┌─────────────────────────────────────────────────────────────────────────────┐
│ 7. SKIP BUTTON (btnSkip click handler, line 968)                           │
└─────────────────────────────────────────────────────────────────────────────┘

   User clicks btnSkip
      ↓
   state.countdown = 0  ← Force countdown to zero
      ↓
   fetchRadio()  ← Immediately fetch next track


┌─────────────────────────────────────────────────────────────────────────────┐
│ 8. AUTO MODE TOGGLE (btnAuto click handler, line 973)                      │
└─────────────────────────────────────────────────────────────────────────────┘

   User clicks btnAuto
      ↓
   state.autoMode = !state.autoMode
      ├─ If true: btnAuto color = accent (#c4956a)
      └─ If false: btnAuto color = dim (#5a5668)


┌─────────────────────────────────────────────────────────────────────────────┐
│ 9. VOLUME SLIDER                                                            │
└─────────────────────────────────────────────────────────────────────────────┘

   HTML: <input type="range" id="volume" min="0" max="100" value="70" />
   
   ⚠️  CURRENTLY DISCONNECTED
   
   - No JavaScript event listener
   - Slider moves visually but does nothing
   - No connection to audio playback (none exists yet)


╔════════════════════════════════════════════════════════════════════════════╗
║                          STATE TRANSITIONS                                  ║
╚════════════════════════════════════════════════════════════════════════════╝

Initial:
┌──────────────────────┐
│ playing: false       │
│ autoMode: true       │
│ countdown: 0         │
│ currentData: null    │
└──────────────────────┘
         ↓
  boot() → fetchRadio()
         ↓
┌──────────────────────┐
│ (fetch in progress)  │
│ loading: true        │
└──────────────────────┘
         ↓
  Response received → UI updates
         ↓
┌──────────────────────┐
│ playing: true        │ ← Auto-toggle if not already
│ autoMode: true       │
│ countdown: 180       │ ← Reset to 3 minutes
│ currentData: {...}   │ ← New song data
└──────────────────────┘
         ↓
Countdown ticks down (180 → 179 → 178 → ... → 0)
         ↓
countdown reaches 0 AND autoMode=true
         ↓
fetchRadio() again (loop)


╔════════════════════════════════════════════════════════════════════════════╗
║              CRITICAL MISSING PIECE FOR YOUTUBE INTEGRATION                 ║
╚════════════════════════════════════════════════════════════════════════════╝

❌ Songs have NO youtubeId field
   └─ Need to add to each song object in SONGS array
      OR create separate songs.json mapping

❌ No audio player initialized
   └─ Need to add YouTube IFrame API script tag
   └─ Need to create YT.Player instance

❌ togglePlay() doesn't actually play audio
   └─ Currently: toggles CSS classes + visual state
   └─ Needed: player.playVideo() / player.pauseVideo()

❌ Countdown doesn't sync with actual audio duration
   └─ Currently: Fixed 180 seconds
   └─ Needed: Use response.radio.duration from API
   └─ Needed: Add duration field to each song

❌ Volume slider disconnected
   └─ Currently: Visual only (no event handler)
   └─ Needed: player.setVolume(value) on change

❌ Waveform is fake animation
   └─ Currently: Random heights + sine wave
   └─ Needed: Connect to Web Audio API analyzer from YouTube player
   └─ OR: Use YouTube API getPlayerState() for basic visualization

