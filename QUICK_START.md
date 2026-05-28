# 🎙️ Distillery Radio - YouTube Integration Quick Start

## 📚 Documentation Files

1. **ANALYSIS.md** - Complete architectural breakdown (16KB)
   - Song database structure
   - Song picking algorithm
   - API endpoint details
   - All DOM element IDs
   - Full code line references

2. **DATA_FLOW.md** - Visual data flow diagrams (15KB)
   - Boot sequence
   - Server-side /api/radio flow
   - Client-side fetchRadio() sequence
   - State transitions
   - All user interactions

3. **YOUTUBE_INTEGRATION.md** - Modification checklist (10KB)
   - Exact code changes needed
   - Before/after snippets
   - Line numbers for each change
   - Testing checklist

---

## ⚡ TL;DR - 5 Minute Summary

### Current State
- ✅ **Works**: Song selection, DJ commentary, weather/system info
- ❌ **Missing**: YouTube audio playback, real volume control
- ❌ **Fake**: Vinyl spinning, waveform, countdown timer

### Song Structure (Each of 77 songs)
```javascript
{
  title, artist, album, year, genre,
  moods: ["serene", "melancholy", ...],
  weight: { deep_night: 9, late_night: 8, ... },
  // ❌ MISSING: youtubeId, duration
}
```

### Main Functions to Modify
| Function | File | Lines | What to Change |
|----------|------|-------|-----------------|
| generateRadioContent() | server.js | 446 | Add youtubeId, duration to response |
| fetchRadio() | index.html | 879 | Load YouTube video with cueVideoById() |
| togglePlay() | index.html | 942 | Call player.playVideo() / pauseVideo() |
| tickCountdown() | index.html | 951 | Sync with actual video duration |
| (NEW) volume handler | index.html | ~985 | Call player.setVolume() on input |

### Critical Files
- `src/server.js` (495 lines) - Add YouTube IDs to SONGS array, duration to API response
- `public/index.html` (1008 lines) - Add player init, modify UI handlers

---

## 🎯 Implementation Steps

### Phase 1: Prepare Song Data (⏱️ Most Time-Consuming)
1. Find YouTube video IDs for all 77 songs
2. Add `youtubeId` and `duration` fields to each song in SONGS array
3. Verify each video actually plays in YouTube

### Phase 2: Server Changes (⏱️ 5 minutes)
1. Modify generateRadioContent() to include youtubeId and duration in response

### Phase 3: Client Changes (⏱️ 30 minutes)
1. Add YouTube IFrame API script tag to <head>
2. Create hidden youtube-player <div>
3. Add player initialization code
4. Modify fetchRadio() to load video
5. Modify togglePlay() to control playback
6. Add volume slider event listener
7. Optionally enhance waveform animation

### Phase 4: Testing (⏱️ 15 minutes)
- [ ] Audio plays in browser
- [ ] Play/pause work
- [ ] Volume slider works
- [ ] Skip button works
- [ ] Auto-advance works
- [ ] Countdown syncs to video length

---

## 🔍 Key Code Locations

### src/server.js
- **Lines 101-177**: SONGS array (77 songs - add youtubeId + duration here)
- **Lines 364-375**: Song scoring algorithm
- **Lines 451-464**: generateRadioContent() - return statement
- **Lines 478-487**: /api/radio endpoint

### public/index.html
- **Line ~20**: CSS variables (already looks good)
- **Line ~630**: End of <head> - add YouTube script here
- **Line ~700**: Before waveform - add youtube-player div here
- **Lines 750-759**: State object (don't need changes)
- **Lines 781-788**: Waveform bar creation (could enhance)
- **Lines 879-939**: fetchRadio() - MODIFY
- **Lines 942-948**: togglePlay() - MODIFY
- **Lines 951-963**: tickCountdown() - MODIFY
- **Lines 966-977**: Button handlers
- **Line ~985**: Add volume handler here

---

## 📊 Current vs. After Integration

```
BEFORE (Current)           AFTER (with YouTube)
─────────────────────      ───────────────────────
No audio                   YouTube audio plays ✓
Vinyl spins (8s loop)      Vinyl syncs to video ✓
Fake waveform              Real waveform vis. ✓
Fixed 180s countdown       Syncs to video length ✓
Volume slider broken       Controls YouTube vol. ✓
Auto-advance (fake timer)  Auto-advance (real end) ✓
Skip loads new song        Skip stops video, loads next ✓
```

---

## 🚨 Most Likely Issues You'll Hit

1. **"Player not ready"** 
   - YouTube IFrame API takes a moment to load
   - Solution: Wait for `playerReady = true` before calling methods

2. **"No audio plays"**
   - Missing youtubeId field on song
   - Video ID is incorrect
   - YouTube blocked the video (regional restrictions)
   - Solution: Check console for errors, test video ID manually

3. **"Countdown doesn't match video length"**
   - Duration field missing or wrong
   - Solution: Add duration to each song object

4. **"Volume slider doesn't work"**
   - Missing event listener
   - Solution: Add the volume handler code

5. **"Waveform doesn't animate"**
   - state.playing flag might not be set correctly
   - Solution: Check that togglePlay() is being called

---

## 🎓 Learning Resources

- YouTube IFrame API: https://developers.google.com/youtube/iframe_api_reference
- Web Audio API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
- JavaScript fetch API: https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API

---

## 📝 Next Steps

1. Read **ANALYSIS.md** to understand the architecture
2. Read **DATA_FLOW.md** to trace execution flow
3. Follow **YOUTUBE_INTEGRATION.md** for exact code changes
4. Search YouTube for each song to get video IDs
5. Implement changes phase by phase
6. Test each phase before moving to next

---

## 💡 Pro Tips

- Start with just 5 songs to test the integration
- Use console.log() to debug player state
- Test on localhost first (easier debugging)
- Keep backup of original files
- Test auto-mode with short videos first
- The beauty of this app is the DJ commentary + context - keep that! 🎙️

---

Generated: 2026-04-25
Documentation by: Claude Code
Project: Distillery Radio YouTube Integration
