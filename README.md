# SongMasher

A browser-native mashup studio. Drop two songs in, and SongMasher finds each one's tempo, beat grid and key, lets you pick one as the **foundation** (the continuous beat), slice **hooks** from the other, and lay them out on a beat-locked timeline. Everything that touches audio — decoding, beat detection, key detection, tempo-matching, pitch-shifting, quick stem splitting and the final render — runs inside your browser with Web Audio and Web Workers. Optional cloud features (Demucs stem separation and a Claude-powered arrangement advisor) light up when you add API keys.

Built with Next.js (App Router), TypeScript, Tailwind v4 and Zustand. Designed to deploy on Vercel.

## What it does

- **Library** – every song you add is analysed once and saved with its analysis, grid and pitch corrections, and any Demucs stems. With a Vercel Blob store configured, the library lives in the cloud and follows you to any device; the browser keeps a local copy of what you've used so reloads are instant. Without Blob, the library is browser-only (IndexedDB). Pick a saved song for deck A or B from the strip at the top, add new files there, or delete songs you no longer want (a second click confirms, and the cloud copy goes too).
- **Analysis on load** – tempo (with an octave sanity check), beat grid and downbeat, musical key with Camelot code, and per-bar energy / rhythm / vocal-presence curves. Runs in a worker, ~1 s per song.
- **Foundation + clips** – one song plays continuously from a bar you choose; bars from either song become clips on three lanes. Clips are dragged, resized and repeated (double-click or `D`), and everything snaps to beats.
- **Beat alignment** – every clip and the foundation are time-stretched (WSOLA, pitch-preserving) to the master tempo and started on the exact bar boundary, so the beats line up.
- **Key matching** – per-song pitch shift in semitones; the advisor tells you the smallest shift that makes the keys compatible.
- **Stems**
  - *Quick stems* – instant vocal / instrumental split using centre-channel cancellation. Local, free, rough but useful.
  - *AI stems* – Demucs via Replicate: vocals, drums, bass + music, instrumental. Cloud, about 1–3 minutes, needs keys (below).
- **Mash advisor** – local heuristics suggest which song should carry the beat, a tempo compromise, a key shift, and the best hook / breakdown bars. With an Anthropic key you can also ask Claude for a full arrangement plan and apply it in one click.
- **Grid fixes** – halve / double tempo, nudge the downbeat by a beat, shift the grid by 10 ms.
- **Export** – renders the arrangement offline to a 16-bit WAV.

## Running locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. No environment variables are needed for the core studio.

Useful checks:

```bash
npm run lint
npx tsc --noEmit
npx tsx scripts/dsp-check.ts   # synthetic click tracks: verifies BPM, downbeat, key and stretching
```

## Deploying to Vercel

1. Push this repository to GitHub and import it in Vercel (framework preset: Next.js). No build settings need changing.
2. Optionally add the environment variables below in the Vercel project settings, then redeploy.

| Variable | Enables | Notes |
| --- | --- | --- |
| `BLOB_READ_WRITE_TOKEN` | Cloud library (songs, corrections and stems sync across devices) | Create a Vercel Blob store on the project (Storage tab) and Vercel adds this for you. Files are stored under `library/<song-id>/` with public, unguessable URLs. |
| `REPLICATE_API_TOKEN` | AI stems (Demucs) | Needs the Blob token too: Replicate fetches the song from your library, and the finished stems are copied back into it. |
| `ANTHROPIC_API_KEY` | "Ask Claude for a plan" in the advisor | Uses `claude-opus-5` with structured output. |
| `ACCESS_CODE` | Protects the cloud library and the AI stems endpoints | Strongly recommended on a public deployment: without it anyone who finds the site can read, add to or delete your library and run paid separations. Users enter the code once; it is remembered in their browser. |
| `DEMUCS_MODEL` / `DEMUCS_VERSION` / `DEMUCS_MODEL_VARIANT` | Override the Replicate model | Defaults to `ryan5453/demucs`, latest version, `htdemucs`. |

`.env.example` lists the same variables for local use.

## How to make a mashup

1. Add songs to the library (Add song, or drop files on it), then press A or B on a song to load it on a deck. Dropping a file straight onto a deck works too. The first loaded song becomes the foundation automatically; the master tempo follows it.
2. Check the advisor. Apply the foundation, tempo and key suggestions you like, or set them manually (deck pitch stepper, master BPM field, "Use as foundation").
3. On the other deck, drag across the waveform to select bars (a click selects a 4-bar phrase). **Audition** loops the selection at the master tempo. **Add to timeline** drops it as a clip after the last clip on lane 1.
4. Select a clip to change its stem or level, repeat it, move it between lanes, or delete it. Drag to move, drag the right edge to resize. Hold `⌥` while dragging for quarter-beat positioning.
5. Split stems when you want the vocal of one song over the instrumental of the other: *Quick* for instant results, *AI* for real separation. The foundation's stem is chosen on its deck; each clip's stem is chosen in the clip toolbar.
6. Press space to play (looping by default), and **Export** when it's right.

## Project layout

```
src/lib/audio/      pure DSP: FFT, analysis (tempo / beats / key), WSOLA stretch + pitch, quick stems, WAV
src/workers/        Web Workers that run the DSP off the main thread
src/lib/engine/     Web Audio scheduling, tempo-matched buffer cache, offline render
src/lib/store.ts    application state and all user actions
src/lib/advisor.ts  local mashup heuristics
src/lib/library.ts  IndexedDB song library (files, analysis, stems)
src/components/     Header (transport), Library, Deck, Waveform, Timeline, Advisor
src/lib/cloud.ts    client for the cloud library API
src/app/api/        config, advise (Claude), library (+upload, stems), stems (Replicate), stems/fetch (audio proxy)
```

## Notes and limits

- Without a Blob store the library lives only in the browser you used, and clearing site data removes it. With Blob, the browser copy is just a cache; deleting a song removes both.
- Songs are held in memory as decoded audio. Two five-minute songs with AI stems use several hundred megabytes; a desktop browser is the intended environment.
- Beat detection assumes a steady tempo. For live recordings or tempo changes, the grid controls let you correct the reading, but clips will drift over long stretches.
- Quick stems rely on vocals being centre-panned, which is true for most modern mixes but not all.
