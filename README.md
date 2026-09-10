# SongMasher

A browser-native mashup studio. Drop two songs in, and SongMasher finds each one's tempo, beat grid and key, lets you pick one as the **foundation** (the continuous beat), slice **hooks** from the other, and lay them out on a beat-locked timeline. Everything that touches audio — decoding, beat detection, key detection, tempo-matching, pitch-shifting, quick stem splitting and the final render — runs inside your browser with Web Audio and Web Workers. Optional cloud features (Demucs stem separation and a Claude-powered arrangement advisor) light up when you add API keys.

Built with Next.js (App Router), TypeScript, Tailwind v4 and Zustand. Designed to deploy on Vercel.

## What it does

- **Library** – every song you add is analysed once and saved with its analysis, grid and pitch corrections, and any Demucs stems. With a Vercel Blob store configured, the library lives in the cloud and follows you to any device; the browser keeps a local copy of what you've used so reloads are instant. Without Blob, the library is browser-only (IndexedDB). Pick a saved song for deck A or B from the strip at the top, add new files there, or delete songs you no longer want (a second click confirms, and the cloud copy goes too).
- **Analysis on load** – tempo (with an octave sanity check), beat grid and downbeat, musical key with Camelot code, and per-bar energy / rhythm / vocal-presence curves. Runs in a worker, ~1 s per song.
- **Foundation + clips** – one song plays continuously from a bar you choose; bars from either song become clips on three lanes. Clips are dragged, resized and repeated (double-click or `D`), and everything snaps to beats. A clip either *layers* over the foundation (right for vocal or melodic stems) or *swaps* the foundation out while it plays (right for anything that brings its own drums), so you never end up with two beats at once. Clips have fade in/out, a millisecond nudge, and an **Align** button that puts the clip's first hit on the beat. Multi-select with shift-click, copy/paste at the playhead, undo/redo.
- **Local mirror** – with the cloud library on, this device keeps audio only for the two songs on the decks; everything else that has a cloud copy is dropped from the browser's storage and streams back when loaded again. Records stay, so the list is always complete, and a song is never dropped until its cloud copy exists.
- **Octave-aware tempo matching** – a song is never stretched to the wrong octave. When one song is close to double or half the other's tempo (say 160 over 80), the vocal keeps its natural speed and rides the beat in double or half time; only the small remainder is stretched, if any. The plan card says so ("double time"), manual clips from such a song take up the right number of timeline beats, and the engine, planner and library match hints all use the same rule: the octave that needs the least stretch wins.
- **Build-ups** – hooks no longer arrive out of nowhere. Every run of hooks is preceded by a lead-in: when the singer's own pre-chorus or verse ending sits right before the hook in the source, it is brought in over the lead so the melody resolves into the hook, and in every case the foundation gets a riser (a high-pass sweep plus a small level dip) that releases exactly on the hook's downbeat, written into the automation lanes when you apply the plan. Before the first and last hook the drop is also teased, melodically where the material allows: the foundation's drums fall away under the lead-in when it has AI stems, the hook's opening line plays once, thinned and echoing out into the gap (a stutter of its first beat instead when the line is not known), a reverse swell of the first beat rises into the downbeat, the hook's own chords creep in under the lead when the vocal song has stems, and one beat of near silence lands the hook with impact. A "Riser" tease style repeats the opening word climbing +2, +4 and +5 semitones into the drop. Clips also have their own pitch shift (semitones, formants preserved on vocals) and FX controls (tempo-synced echo, reverse) in the clip toolbar; clips render only their own window of the song, so short parts and per-clip pitches are quick to prepare ("Tease the drop" chip). The **Build-ups** chip turns it off; "no build-up" or "bigger drop" in the refinement box does the same through Claude.
- **DJ fundamentals** – three toggles in the timeline toolbar bring the classic mixing disciplines to both Claude's plans and manual work. *Phrase lock*: the foundation's 4- and 8-bar phrases (counted from its detected sections) are marked on the grid, drops and moves snap to them, and the planner scores every part on starting at a phrase of its own song and landing on a phrase of the foundation (the **Phrasing** meter), so an incoming part arrives where the outgoing one does. *EQ mixing*: every clip and the foundation get a three-band EQ (low shelf 220 Hz, mid 1.2 kHz, high shelf 5 kHz, with a kill per band); with the toggle on, parts layered over the foundation give up their lows automatically so two basslines never fight, and layered vocals lose their rumble; swapped sections keep everything. *Harmonic mixing*: the plan card's **Keys** line shows both keys on the Camelot wheel, the semitone shift chosen, and whether they end up the same, relative, neighbouring or clashing; the planner's chord-fit score and the library's match hints use the same rules.
- **Match hints** – once a song is on deck A (or B), every other library card gets a Great / Good / Fair / Poor badge for how well it would mash with it: same, relative or neighbouring Camelot keys score highest (a shift of a semitone or two is allowed), and tempos that need little stretching, counting half and double time. Great matches glow, poor ones fade, hovering a badge explains the verdict, and the library sorts by match until you pick another order.
- **Song structure** – each song gets intro / verse / chorus / bridge / break / outro blocks above its waveform from a self-similarity analysis, with the strongest chorus marked as the hook. Click a block to select it, drag it straight onto the timeline, drag its edges to move boundaries, double-click to relabel, right-click to split or merge. Edits are saved with the song and respected by the planner; "Re-detect sections" in the grid panel starts over, and "Tap" sets the tempo by tapping along (four taps or more), "Re-analyse" runs tempo, downbeat and key detection again (songs analysed by an older version keep their old reading until you do; ÷2 and ×2 fix an octave error in one click and are saved with the song). The foundation block on the timeline shows the same labels. Waveforms zoom (⌘-wheel) down to beat level.
- **Automation and transitions** – a Level and a Filter lane on the foundation (low-pass below centre, high-pass above), a master limiter, loop region (drag the ruler or `L`), cue markers (`M`), metronome and one-bar count-in.
- **Mashup projects** – save with ⌘S, reopen from the Library, and the session autosaves so a reload offers to restore it.
- **Beat alignment** – every clip and the foundation are time-stretched (WSOLA, pitch-preserving) to the master tempo and started on the exact bar boundary, so the beats line up.
- **Key matching** – per-song pitch shift in semitones; the advisor tells you the smallest shift that makes the keys compatible. Vocal stems are shifted with formant preservation so they don't sound chipmunked.
- **Stems**
  - *Quick stems* – instant vocal / instrumental split using centre-channel cancellation. Local, free, rough but useful.
  - *AI stems* – Demucs via Replicate: vocals, drums, bass + music, instrumental. Cloud, about 1–3 minutes, needs keys (below). Pick the standard, fine-tuned (cleaner vocals) or 6-stem variant per run.
- **Mash advisor** – a computational planner does the musical work: it searches every foundation start bar, vocal segment, pitch shift (±3 st) and arrangement template, and scores each candidate on bar-by-bar **chord fit** (chroma agreement between the vocal's notes and the foundation's harmony, with semitone-clash penalties), **phrase completeness** (clips start on sung phrases, pickups included, and never cut through one), **energy shape** (choruses in hook slots, quieter passages in breakdowns) and **tempo stretch**. Run AI stems on the vocal song first: the planner then reads phrases, per-bar vocal energy and melody chroma from the isolated vocal. Plans come with meters, an **Audition hook** button that loops the first hook over the foundation before you commit, alternatives, and quick adjustments (vocal earlier, more energy, longer, swap roles, no pitch shift, **both vocals**). Both vocals switches to the **Duet** templates: the singers take turns, and the foundation song's own vocal is layered back over its instrumental in place wherever its chorus fits, so both hooks appear without two lead vocals ever overlapping (run AI stems on both songs for the cleanest result; without a vocal stem the other chorus is swapped in as a full-mix section instead). With an Anthropic key, **Plan with Claude** hands the scored candidates to Claude, which chooses, labels the parts, explains the plan, recommends Demucs variants, and turns follow-up instructions ("make the drop hit harder") into new search constraints. Claude also uses what it knows about the songs themselves: each file's title and artist tags (ID3, FLAC, MP4; double-click a library card's name to edit them; songs without tags are filled in automatically, from the stored file's own tags where they exist and otherwise by asking Claude once from the file name, length and tempo, with a plain reading of the file name as the fallback, and the editor's Guess button asks again on demand) are sent along, and when it recognises a song it names the moments a listener expects and can ask the planner to open with an iconic intro riff, which the planner then builds around. The plan says what it recognised, and the "Song knowledge" chip turns this off. Every applied plan still passes the guard-rails in `src/lib/planRules.ts`.
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

1. Add songs to the library (Add song, or drop files on it), then press A or B on a song to load it on a deck. Dropping a file straight onto a deck works too. The first loaded song becomes the foundation automatically; the master tempo follows it. Lossless files (FLAC, WAV, AIFF) are converted to 320 kbps MP3 as they are added, in a background worker, so a song takes about a tenth of the space and uploads in seconds; the beat grid is measured on the MP3 itself so playback and grid always agree. Older lossless songs are converted the first time they upload for AI stems.
2. Check the advisor. Apply the foundation, tempo and key suggestions you like, or set them manually (deck pitch stepper, master BPM field, "Use as foundation").
3. On the other deck, drag across the waveform to select bars (a click selects a 4-bar phrase). **Audition** loops the selection at the master tempo. Then either drag the highlighted selection straight onto a timeline lane (the clip's start follows the cursor and snaps to the bar, or to the beat with `⌥` held; anywhere over the timeline is a valid drop, with the ruler and foundation row meaning "use as foundation" and the automation row going to lane 1) or press **Add to timeline** to append it to lane 1. Dropping a selection on the Foundation lane makes that song the foundation from those bars. Library cards can be dragged onto a deck to load them.
4. The timeline has three clip lanes by default and up to six (the + and − next to the last lane label); lanes only lay parts out, everything on them plays together. Click a clip to hear it on its own at the master tempo (click again, or press the little play button on it, to stop); other clips dim while it plays. Select a clip to change its stem or level, repeat it, move it between lanes, or delete it. Drag to move, drag the right edge to resize. Hold `⌥` while dragging for quarter-beat positioning.
5. Split stems when you want the vocal of one song over the instrumental of the other: *Quick* for instant results, *AI* for real separation. An AI job is remembered on the song itself, so you can close the tab or switch devices while Demucs runs (the fine-tuned model takes several minutes): the stems are saved by a completion callback from Replicate and collected the next time the song is loaded, without starting a second job. The foundation's stem is chosen on its deck; each clip's stem is chosen in the clip toolbar.
6. **Tight timing** (on by default, in the timeline toolbar) fixes vocals that drift off the beat. A constant-tempo grid slowly slides against a real recording, so a clip cut from bar 90 can sit tens of milliseconds off the foundation's actual beats. Before playing, the engine listens to where the beats really fall in both songs (the clip at its source, the foundation where the clip lands) and nudges the clip so real beat meets real beat; each clip shows the nudge it received. AI stems are also aligned sample-accurately to the full mix when they load. Turn it off to place clips exactly on the nominal grid.
7. **Match levels** (on by default, in the timeline toolbar) measures each part's loudness at its source and trims it to a common level before your own clip gains, so a quiet vocal stem and a loud full mix sit together without hand-balancing; each clip shows the trim it received after you play. Swapped-in sections match the foundation exactly, layered stems sit a few dB under it. Turn it off to hear parts at their source volume.
8. Press space to play (looping by default), and **Export** when it's right.
9. **Start over** in the header empties both decks, the timeline and the plan (click twice to confirm). Songs and saved mashups stay in the library.

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
