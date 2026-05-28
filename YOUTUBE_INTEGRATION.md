# CODE SECTIONS TO MODIFY FOR YOUTUBE INTEGRATION

## 📋 Quick Reference - What Needs to Change

### 1. Server-Side Changes (src/server.js)

#### Add YouTube IDs and Duration to Each Song
**Current (Line 103):**
```javascript
{ title: "Gymnopdie No.1", artist: "Erik Satie", album: "Gymnopedies", year: "1888", genre: "Classical", moods: ["serene","melancholy","night","rainy","quiet"], weight: { deep_night: 9, late_night: 8, rain: 7, low_load: 8 } },
```

**NEEDS TO ADD:**
```javascript
youtubeId: "SnzJ1Ci_pIk",  // Find the correct YouTube video ID
duration: 218,              // Duration in seconds
```

---

### 2. Client-Side Changes (public/index.html)

#### A. Add YouTube IFrame API Script
**ADD TO HEAD (before closing </head>):**

Line: ~630 (before closing </head> tag)

```html
<!-- YouTube IFrame API -->
<script async defer src="https://www.youtube.com/iframe_api"></script>
```

---

#### B. Add YouTube Player Container
**MODIFY HTML around line 700:**

Current (only waveform container):
```html
<!-- Waveform -->
<div class="waveform-container" id="waveform"></div>
```

**ADD BEFORE IT:**
```html
<!-- YouTube Player (hidden) -->
<div id="youtube-player" style="display:none;"></div>

<!-- Waveform -->
<div class="waveform-container" id="waveform"></div>
```

---

#### C. Modify JavaScript - Add Player Initialization

**AFTER STATE OBJECT (after line 759), ADD:**

```javascript
// ── YouTube Player ──────────────────────────────────────────────
let player;
let playerReady = false;

function onYouTubeIframeAPIReady() {
  console.log('YouTube IFrame API ready');
  player = new YT.Player('youtube-player', {
    width: '0',
    height: '0',
    videoId: '', // Will be set dynamically
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError: onPlayerError,
    },
    playerVars: {
      autoplay: 0,
      controls: 0,
      modestbranding: 1,
      fs: 0,
      rel: 0,
      showinfo: 0,
    }
  });
}

function onPlayerReady(event) {
  console.log('YouTube player ready');
  playerReady = true;
}

function onPlayerStateChange(event) {
  // YT.PlayerState.PLAYING = 1
  // YT.PlayerState.PAUSED = 2
  // YT.PlayerState.ENDED = 0
  console.log('Player state changed:', event.data);
  
  if (event.data === YT.PlayerState.ENDED) {
    // Video finished, auto-advance to next
    if (state.autoMode) {
      state.countdown = 0;
      tickCountdown(); // Trigger next track
    }
  }
}

function onPlayerError(event) {
  console.error('YouTube player error:', event.data);
  // Try to play next track on error
  if (state.autoMode) {
    state.countdown = 0;
    tickCountdown();
  }
}
```

---

#### D. MODIFY fetchRadio() Function

**LOCATION: Line 879-939**

**Current code at line 927 (around "Start playing if not already"):**
```javascript
// Start playing
if (!state.playing) togglePlay();

// Reset countdown
state.countdown = state.autoInterval;
```

**CHANGE TO:**
```javascript
// Load YouTube video
if (playerReady && radio.song.youtubeId) {
  player.cueVideoById(radio.song.youtubeId);
  console.log('Queued YouTube video:', radio.song.youtubeId);
}

// Start playing
if (!state.playing) togglePlay();

// Reset countdown to actual video duration (with buffer)
if (radio.song.duration) {
  state.countdown = radio.song.duration + 10; // Add 10s buffer
} else {
  state.countdown = state.autoInterval; // Fallback
}
```

---

#### E. MODIFY togglePlay() Function

**LOCATION: Line 942-948**

**Current:**
```javascript
function togglePlay() {
  state.playing = !state.playing;
  vinyl.classList.toggle('spinning', state.playing);
  tonearm.classList.toggle('playing', state.playing);
  onAir.classList.toggle('active', state.playing);
  btnPlay.innerHTML = state.playing ? '&#10074;&#10074;' : '&#9654;';
}
```

**CHANGE TO:**
```javascript
function togglePlay() {
  state.playing = !state.playing;
  vinyl.classList.toggle('spinning', state.playing);
  tonearm.classList.toggle('playing', state.playing);
  onAir.classList.toggle('active', state.playing);
  btnPlay.innerHTML = state.playing ? '&#10074;&#10074;' : '&#9654;';
  
  // NEW: Control YouTube playback
  if (playerReady && player) {
    if (state.playing) {
      player.playVideo();
    } else {
      player.pauseVideo();
    }
  }
}
```

---

#### F. ADD Volume Slider Event Handler

**LOCATION: After button event listeners (around line 981)**

**ADD:**
```javascript
// ── Volume control ──────────────────────────────────────────────
const volumeSlider = $('volume');
volumeSlider.addEventListener('input', (e) => {
  const volume = parseInt(e.target.value);
  if (playerReady && player) {
    player.setVolume(volume);
  }
});
```

---

#### G. MODIFY tickCountdown() Function

**LOCATION: Line 951-963**

**Current:**
```javascript
function tickCountdown() {
  if (state.playing && state.autoMode && state.countdown > 0) {
    state.countdown--;
    const m = Math.floor(state.countdown / 60);
    const s = state.countdown % 60;
    countdownEl.textContent = `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    if (state.countdown <= 0) {
      fetchRadio();
    }
  }
}
```

**CHANGE TO:**
```javascript
function tickCountdown() {
  if (state.playing && state.autoMode && state.countdown > 0) {
    state.countdown--;
    const m = Math.floor(state.countdown / 60);
    const s = state.countdown % 60;
    countdownEl.textContent = `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    if (state.countdown <= 0) {
      // Check actual player state to handle videos that ended
      if (playerReady && player && player.getPlayerState && 
          player.getPlayerState() === YT.PlayerState.ENDED) {
        // Player already ended
        fetchRadio();
      } else if (!playerReady) {
        // Fallback for when player not ready
        fetchRadio();
      }
    }
  }
}
```

---

#### H. OPTIONAL: Update animateWaveform() for Real Audio

**LOCATION: Line 790-804**

**Current (purely fake animation):**
```javascript
function animateWaveform() {
  waveBars.forEach((bar, i) => {
    if (state.playing) {
      const h = 4 + Math.random() * 36 * (0.5 + 0.5 * Math.sin(Date.now() / 400 + i * 0.3));
      bar.style.height = h + 'px';
      bar.classList.add('active');
    } else {
      const h = 3 + Math.sin(Date.now() / 2000 + i * 0.2) * 2;
      bar.style.height = h + 'px';
      bar.classList.remove('active');
    }
  });
  requestAnimationFrame(animateWaveform);
}
```

**CAN ENHANCE TO (optional - adds visual sync):**
```javascript
function animateWaveform() {
  waveBars.forEach((bar, i) => {
    if (state.playing && playerReady && player) {
      try {
        // Get current playback progress (0-1)
        const duration = player.getDuration();
        const currentTime = player.getCurrentTime();
        const progress = currentTime / duration;
        
        // Combine real progress with random animation
        const h = 4 + Math.random() * 36 * 
                  (0.5 + 0.5 * Math.sin(Date.now() / 400 + i * 0.3 + progress * Math.PI));
        bar.style.height = h + 'px';
        bar.classList.add('active');
      } catch (e) {
        // Fallback if player methods unavailable
        const h = 4 + Math.random() * 36 * (0.5 + 0.5 * Math.sin(Date.now() / 400 + i * 0.3));
        bar.style.height = h + 'px';
        bar.classList.add('active');
      }
    } else {
      const h = 3 + Math.sin(Date.now() / 2000 + i * 0.2) * 2;
      bar.style.height = h + 'px';
      bar.classList.remove('active');
    }
  });
  requestAnimationFrame(animateWaveform);
}
```

---

### 3. Server-Side: Add Duration Field to API Response

**LOCATION: src/server.js, lines 451-464**

**Current:**
```javascript
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
  },
  ambient_tags: tags,
};
```

**CHANGE TO:**
```javascript
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
    youtubeId: song.youtubeId || '',  // ADD THIS
    duration: song.duration || 180,   // ADD THIS
  },
  ambient_tags: tags,
};
```

---

## 🔑 Key Points to Remember

### DOM Element IDs Involved
- `youtube-player` (NEW - hidden container)
- `volume` (EXISTING - needs event listener)
- `vinyl` (existing CSS animation control)
- `tonearm` (existing CSS animation control)
- `btn-play` (existing click handler)
- `countdown` (existing - will now sync to video duration)

### State Changes
```javascript
state.playerReady = false  // Add to track player readiness
state.currentVideoId = ''  // Optional: track current video
```

### Critical Order of Operations
1. ✅ YouTube IFrame API loads (`onYouTubeIframeAPIReady` called)
2. ✅ Player instance created
3. ✅ `playerReady = true`
4. ✅ User presses play
5. ✅ `togglePlay()` → `player.playVideo()`
6. ✅ Waveform animates based on `state.playing`
7. ✅ Countdown ticks down (synced to video duration)
8. ✅ Video ends → `onPlayerStateChange` called with ENDED state
9. ✅ If autoMode: fetch next radio content
10. ✅ New video ID loaded → cue video → play

---

## 🚨 GOTCHAS & TESTING

### YouTube IFrame API Limitations
- **Must be HTTPS** (or localhost for testing)
- **CORS restrictions** may apply depending on hosting
- **autoplay restrictions** - user must interact first
- **Audio context** from embedded YouTube videos is limited

### Testing Checklist
- [ ] YouTube videos actually play (sound in browser)
- [ ] Play/pause buttons work with video
- [ ] Volume slider controls YouTube volume
- [ ] Countdown matches video duration
- [ ] Skip button kills current video and loads next
- [ ] Auto-mode advances to next song when video ends
- [ ] Waveform animates differently when playing vs paused
- [ ] Vinyl spins when playing, stops when paused
- [ ] Tonearm rotates to proper position

---

## 📝 Songs Without YouTube IDs

You'll need to find YouTube video IDs for all 77 songs. Some suggestions:
- Search "Song Title Artist YouTube" 
- Use YouTube Data API to search programmatically
- Or find a public JSON file with YouTube music mappings
- Consider using a service like YouTube Music or Spotify for lookups

