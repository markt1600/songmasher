# SongMasher

Browser-native two-song mashup studio (Next.js App Router, TypeScript, Tailwind v4, Zustand). Deployed on Vercel.

- `src/lib/audio/` pure DSP (no DOM): FFT, tempo/beat/key analysis, WSOLA time-stretch + pitch shift, quick mid/side stems, WAV encoder.
- `src/workers/` Web Workers wrapping the DSP; `src/lib/workers.ts` is the promise-based client.
- `src/lib/engine/engine.ts` Web Audio scheduler: builds beat-aligned events from a `Project`, caches tempo-matched buffers, plays/loops/renders.
- `src/lib/store.ts` Zustand store: decks, project (foundation + clips), transport, stem separation flows, advisor.
- `src/app/api/` optional server features: `advise` (Claude plan), `stems*` (Demucs via Replicate + Vercel Blob), `config`.

Commands: `npm run dev`, `npm run build`, `npm run lint`, `npx tsc --noEmit`.
DSP sanity script: `npx tsx scripts/dsp-check.ts` (synthetic click tracks; checks BPM, downbeat, key, stretch).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
