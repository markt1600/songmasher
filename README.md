# SongMasher

A browser-native mashup studio. Drop two songs in, and SongMasher finds each one's tempo, beat grid and key, lets you pick one as the **foundation** (the continuous beat), slice **hooks** from the other, and lay them out on a beat-locked timeline. Everything that touches audio — decoding, beat detection, key detection, tempo-matching, pitch-shifting, quick stem splitting and the final render — runs inside your browser with Web Audio and Web Workers. Optional cloud features (Demucs stem separation and a Claude-powered arrangement advisor) light up when you add API keys.

Built with Next.js (App Router), TypeScript, Tailwind v4 and Zustand. Designed to deploy on Vercel.

## What it does

- **Library** – every song you add is analysed once and saved with its analysis, grid and pitch corrections, and any Demucs stems. With a Vercel Blob store configured, the library lives in the cloud and follows you to any device; the browser keeps a local copy of what you've used so reloads are instant. Without Blob, the library is browser-only (IndexedDB). Pick a saved song for deck A or B from the strip at the top, add new files there, or delete songs you no longer want (a second click confirms, and the cloud copy goes too).
- **Analysis on load** – tempo (with an octave sanity check), beat grid and downbeat, musical key with Camelot code, and per-bar energy / rhythm / vocal-presence curves. Runs in a worker, ~1 s per song.
- **Foundation + clips** – one song plays continuously from a bar you choose; bars from either song become clips on three lanes. Clips are dragged, resized and repeated (double-click or `D`), and everything snaps to beats. A clip either *layers* over the foundation (right for vocal or melodic stems) or *swaps* the foundation out while it plays (right for anything that brings its own drums), so you never end up with two beats at once. Clips have fade in/out, a millisecond nudge, and an **Align** button that puts the clip's first hit on the beat. Multi-select with shift-click, copy/paste at the playhead, undo/redo.
- **Song structure** – each song gets intro / verse / chorus / bridge / break / outro blocks above its waveform from a self-similarity analysis, with the strongest chorus marked as the hook. Click a block to select it, drag it straight onto the timeline, drag its edges to move boundaries, double-click to relabel, right-click to split or merge. Edits are saved with the song and respected by the planner; "Re-detect sections" in the grid panel starts over. The foundation block on the timeline shows the same labels. Waveforms zoom (⌘-wheel) down to beat level.
- **Automation and transitions** – a Level and a Filter lane on the foundation (low-pass below centre, high-pass above), a master limiter, loop region (drag the ruler or `L`), cue markers (`M`), metronome and one-bar count-in.
- **Mashup projects** – save with ⌘S, reopen from the Library, and the session autosaves so a reload offers to restore it.
- **Beat alignment** – every clip and the foundation are time-stretched (WSOLA, pitch-preserving) to the master tempo and started on the exact bar boundary, so the beats line up.
- **Key matching** – per-song pitch shift in semitones; the advisor tells you the smallest shift that makes the keys compatible. Vocal stems are shifted with formant preservation so they don't sound chipmunked.
- **Stems**
  - *Quick stems* – instant vocal / instrumental split using centre-channel cancellation. Local, free, rough but useful.
  - *AI stems* – Demucs via Replicate: vocals, drums, bass + music, instrumental. Cloud, about 1–3 minutes, needs keys (below). Pick the standard, fine-tuned (cleaner vocals) or 6-stem variant per run.
- **Mash advisor** – a computational planner does the musical work: it searches every foundation start bar, vocal segment, pitch shift (±3 st) and arrangement template, and scores each candidate on bar-by-bar **chord fit** (chroma agreement between the vocal's notes and the foundation's harmony, with semitone-clash penalties), **phrase completeness** (clips start on sung phrases, pickups included, and never cut through one), **energy shape** (choruses in hook slots, quieter passages in breakdowns) and **tempo stretch**. Run AI stems on the vocal song first: the planner then reads phrases, per-bar vocal energy and melody chroma from the isolated vocal. Plans come with meters, an **Audition hook** button that loops the first hook over the foundation before you commit, alternatives, and quick adjustments (vocal earlier, more energy, longer, swap roles, no pitch shift, **both vocals**). Both vocals switches to the **Duet** templates: the singers take turns, and the foundation song's own vocal is layered back over its instrumental in place wherever its chorus fits, so both hooks appear without two lead vocals ever overlapping (run AI stems on both songs for the cleanest result; without a vocal stem the other chorus is swapped in as a full-mix section instead). With an Anthropic key, **Plan with Claude** hands the scored candidates to Claude, which chooses, labels the parts, explains the plan, recommends Demucs variants, and turns follow-up instructions ("make the drop hit harder") into new search constraints. Every applied plan still passes the guard-rails in `src/lib/planRules.ts`.
- **Grid fixes** – halve / double tempo, nudge the downbeat by a beat, shift the grid by 10 ms.
- **Export** – WAV or MP3, whole arrangement or just the loop region, optional loudness normalisation to −14 LUFS. Ticking *Save to library* keeps the render as a playable mix; with the cloud library it also gets a public share page at `/m/<id>`.

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
3. On the other deck, drag across the waveform to select bars (a click selects a 4-bar phrase). **Audition** loops the selection at the master tempo. Then either drag the highlighted selection straight onto a timeline lane (it snaps to bars; hold `⌥` for beats) or press **Add to timeline** to append it to lane 1. Dropping a selection on the Foundation lane makes that song the foundation from those bars. Library cards can be dragged onto a deck to load them.
4. Click a clip to hear it on its own at the master tempo (click again, or press the little play button on it, to stop); other clips dim while it plays. Select a clip to change its stem or level, repeat it, move it between lanes, or delete it. Drag to move, drag the right edge to resize. Hold `⌥` while dragging for quarter-beat positioning.
5. Split stems when you want the vocal of one song over the instrumental of the other: *Quick* for instant results, *AI* for real separation. The foundation's stem is chosen on its deck; each clip's stem is chosen in the clip toolbar.
6. **Match levels** (on by default, in the timeline toolbar) measures each part's loudness at its source and trims it to a common level before your own clip gains, so a quiet vocal stem and a loud full mix sit together without hand-balancing; each clip shows the trim it received after you play. Swapped-in sections match the foundation exactly, layered stems sit a few dB under it. Turn it off to hear parts at their source volume.
7. Press space to play (looping by default), and **Export** when it's right.

## Project layout

```
src/lib/audio/      pure DSP: FFT, analysis (tempo / beats / key / chroma), sections, vocal profile (phrases), WSOLA stretch + pitch (+ formants), quick stems, align, loudness, WAV/MP3
src/workers/        Web Workers that run the DSP off the main thread
src/lib/engine/     Web Audio scheduling, tempo-matched buffer cache, offline render
src/lib/store.ts    application state and all user actions
src/lib/advisor.ts  local mashup heuristics
src/lib/library.ts  IndexedDB song library (files, analysis, stems)
src/components/     Header (transport, export, project), Library (songs, mashups, mixes), Deck, Waveform, Timeline (automation, cues, loop), Advisor, DragLayer
src/app/m/[id]/     public player page for shared mixes
src/lib/cloud.ts    client for the cloud library API
src/app/api/        config, advise (Claude), library (+upload, stems), stems (Replicate), stems/fetch (audio proxy)
```

## Notes and limits

- Without a Blob store the library lives only in the browser you used, and clearing site data removes it. With Blob, the browser copy is just a cache; deleting a song removes both.
- Songs are held in memory as decoded audio. Two five-minute songs with AI stems use several hundred megabytes; a desktop browser is the intended environment.
- Beat detection assumes a steady tempo. For live recordings or tempo changes, the grid controls let you correct the reading, but clips will drift over long stretches.
- Quick stems rely on vocals being centre-panned, which is true for most modern mixes but not all.
