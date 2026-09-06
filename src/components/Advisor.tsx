"use client";
import { useState, type ReactNode } from "react";
import { useStore } from "@/lib/store";
import { DECK_COLORS } from "@/lib/types";
import type { PlanCandidate, PlanConstraints } from "@/lib/mash/planner";
import { Icon } from "./ui";

const KIND_ICON: Record<string, string> = { foundation: "anchor", tempo: "loop", key: "music", hook: "scissors", verse: "scissors", beat: "anchor", info: "check" };
/** Every constraint explicitly cleared: the planner falls back to its own choices. */
const RESET: PlanConstraints = { foundation: undefined, lengthBars: undefined, vocalEntryBar: undefined, hookBars: undefined, energy: undefined, maxShift: undefined, template: undefined, vocals: undefined };

/** An adjust chip that stays lit while its constraint is active; clicking again clears it. */
function Chip({ on, title, onClick, children }: { on: boolean; title?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button className={`btn btn-xs ${on ? "text-accent-2 border-[#7c6cff]/60 bg-[#7c6cff]/15" : ""}`} onClick={onClick} title={title} aria-pressed={on}>
      {on ? "✓ " : ""}
      {children}
    </button>
  );
}

const TEMPLATE_NAME: Record<string, string> = { classic: "Classic", "vocal-first": "Vocal first", "call-response": "Call & response", extended: "Extended", duet: "Duet", "duet-verse": "Duet (verse first)" };

function Meter({ label, value, title }: { label: string; value: number; title: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const color = pct >= 70 ? "#30d158" : pct >= 50 ? "#ffd60a" : "#ff6b61";
  return (
    <div className="flex flex-col gap-1 min-w-[84px]" title={title}>
      <div className="flex items-baseline justify-between">
        <span className="label">{label}</span>
        <span className="font-mono tabular-nums text-[11px]" style={{ color }}>
          {pct}%
        </span>
      </div>
      <div className="h-1 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

export default function Advisor() {
  const suggestions = useStore((s) => s.suggestions);
  const config = useStore((s) => s.config);
  const decks = useStore((s) => s.decks);
  const candidates = useStore((s) => s.candidates);
  const selectedId = useStore((s) => s.selectedCandidateId);
  const claudeNotes = useStore((s) => s.claudeNotes);
  const claudePlan = useStore((s) => s.claudePlan);
  const claudeBusy = useStore((s) => s.claudeBusy);
  const claudeError = useStore((s) => s.claudeError);
  const auditioning = useStore((s) => s.auditioning);
  const playing = useStore((s) => s.playing);
  const planHistory = useStore((s) => s.planHistory);
  const constraints = useStore((s) => s.planConstraints);
  const { applySuggestion, askClaude, refinePlan, separateAI, planMashup, selectCandidate, auditionCandidate, stopAudition, applyCandidate } = useStore();
  const [instruction, setInstruction] = useState("");
  const bothReady = decks.A.status === "ready" && decks.B.status === "ready";
  const missingStems = (["A", "B"] as const).filter((id) => decks[id].status === "ready" && !decks[id].buffers.vocals);
  const selected = candidates.find((c) => c.id === selectedId) ?? null;
  const isAuditioning = auditioning && playing;

  // Quick adjustments apply instantly through the local search; with Claude on, it then re-chooses and explains.
  const quick = (patch: PlanConstraints, label: string) => {
    const next: PlanConstraints = { ...constraints, ...patch };
    for (const k of Object.keys(next) as (keyof PlanConstraints)[]) if (next[k] === undefined) delete next[k];
    planMashup(next);
    if (config.ai) void refinePlan(label);
  };

  if (!bothReady && suggestions.length === 0) return null;

  return (
    <section className="panel p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="h-7 w-7 rounded-[8px] bg-gradient-to-b from-[#9d8cff] to-[#6f5cff] grid place-items-center shadow-[0_1px_0_rgba(255,255,255,0.25)_inset]">
          <Icon name="sparkles" size={13} />
        </div>
        <div className="font-semibold text-[14px] tracking-[-0.01em]">Mash advisor</div>
        <span className="text-[11.5px] text-muted">Scores every arrangement by chord fit, phrase boundaries, energy and stretch</span>
        <div className="flex-1" />
        <button className="btn btn-sm" disabled={!bothReady || claudeBusy} onClick={() => planMashup()} title="Search arrangements locally (no API key needed)">
          <Icon name="wand" size={12} /> Plan mashup
        </button>
        <button className="btn btn-sm btn-primary" disabled={!config.ai || !bothReady || claudeBusy} onClick={() => void askClaude()} title={config.ai ? "Search, then let Claude choose and explain the best arrangement" : "Set ANTHROPIC_API_KEY on the server to enable"}>
          {claudeBusy ? <span className="h-3 w-3 rounded-full border-2 border-white/30 border-t-white animate-spin" /> : <Icon name="sparkles" size={12} />} Plan with Claude
        </button>
      </div>

      {bothReady && missingStems.length > 0 && (
        <div className="text-[11.5px] text-muted">
          Tip: run AI stems on deck {missingStems.join(" and ")} first. The planner then knows exactly where the singing is and can layer a clean vocal over the other song&apos;s instrumental; without stems it can only alternate sections.
        </div>
      )}
      {claudeError && <div className="text-[12px] text-[#ff6b61]">{claudeError}</div>}

      {selected && (
        <div className={`rounded-[12px] border border-[#7c6cff]/30 bg-[#7c6cff]/10 p-4 flex flex-col gap-3 fade-in ${claudeBusy ? "thinking" : ""}`} aria-busy={claudeBusy}>
          {claudeBusy && (
            <div className="flex items-center gap-2.5 rounded-[10px] bg-[#7c6cff]/20 border border-[#9d8cff]/40 px-3 py-2 text-[12.5px]" role="status">
              <span className="h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin shrink-0" />
              <span>
                <b className="thinking-label">Claude is {planHistory.length || instruction ? "revising the plan" : "choosing the best arrangement"}</b>
                <span className="text-text-2"> The plan below may still change. Hold off on Apply until it settles.</span>
              </span>
            </div>
          )}
          <div className={`flex flex-wrap items-center gap-2 ${claudeBusy ? "thinking-dim" : ""}`}>
            <Icon name="wand" size={14} />
            <div className="font-medium">
              {TEMPLATE_NAME[selected.template]} · {decks[selected.foundation.deck].name} under {decks[selected.vocalDeck].name}
            </div>
            <span className="chip">
              <b>{selected.masterBpm.toFixed(1)}</b> BPM
            </span>
            {selected.semitones !== 0 && (
              <span className="chip">
                {decks[selected.vocalDeck].id} {selected.semitones > 0 ? "+" : ""}
                {selected.semitones} st
              </span>
            )}
            <span className="chip">
              <b>{selected.lengthBars}</b> bars
            </span>
            <div className="flex-1" />
            <button className="btn btn-sm" disabled={claudeBusy} onClick={() => (isAuditioning ? stopAudition() : void auditionCandidate(selected.id))} title="Loop the first hook over the foundation without changing your timeline">
              <Icon name={isAuditioning ? "stop" : "play"} size={11} /> {isAuditioning ? "Stop" : "Audition hook"}
            </button>
            <button className="btn btn-sm btn-primary" disabled={claudeBusy} onClick={() => applyCandidate(selected.id)} title={claudeBusy ? "Wait for Claude to finish" : "Build this arrangement on the timeline"}>
              {claudeBusy ? "Waiting for Claude…" : "Apply plan"}
            </button>
          </div>

          <div className={`flex flex-wrap gap-4 ${claudeBusy ? "thinking-dim" : ""}`}>
            <Meter label="Chord fit" value={selected.breakdown.harmony} title="How well the vocal's notes agree with the foundation's chords, bar by bar" />
            <Meter label="Phrases" value={selected.breakdown.phrases} title="Clips start and end on sung phrases instead of cutting through them" />
            <Meter label="Energy" value={selected.breakdown.energy} title="Loud vocal parts land in hook slots, quieter ones in breakdowns" />
            <Meter label="Stretch" value={selected.breakdown.stretch} title="How little time-stretching the tempo match needs" />
          </div>

          <p className={`text-sm leading-relaxed ${claudeBusy ? "thinking-dim" : ""}`}>{claudeNotes?.choice === selected.id ? claudeNotes.summary : selected.description}</p>

          <div className={`overflow-x-auto ${claudeBusy ? "thinking-dim" : ""}`}>
            <table className="text-[0.72rem] w-full">
              <thead className="text-muted">
                <tr className="text-left">
                  <th className="pr-3 py-1 font-medium">Timeline bar</th>
                  <th className="pr-3 py-1 font-medium">Part</th>
                  <th className="pr-3 py-1 font-medium">Source bars</th>
                  <th className="pr-3 py-1 font-medium">Stem</th>
                  <th className="pr-3 py-1 font-medium">Mode</th>
                  <th className="pr-3 py-1 font-medium">Chord fit</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-white/8">
                  <td className="pr-3 py-1 font-mono">1</td>
                  <td className="pr-3 py-1" style={{ color: DECK_COLORS[selected.foundation.deck].main }}>
                    {selected.foundation.deck} · Foundation
                  </td>
                  <td className="pr-3 py-1 font-mono">from {selected.foundation.startBar + 1}</td>
                  <td className="pr-3 py-1">{selected.foundation.stem}</td>
                  <td className="pr-3 py-1">continuous</td>
                  <td className="pr-3 py-1">—</td>
                </tr>
                {selected.clips.map((k, i) => (
                  <tr key={i} className="border-t border-white/8">
                    <td className="pr-3 py-1 font-mono">{Math.floor(k.startBeat / 4) + 1}{k.startBeat % 4 !== 0 ? ` (${((k.startBeat % 4) + 4) % 4 - 4} beat pickup)` : ""}</td>
                    <td className="pr-3 py-1" style={{ color: DECK_COLORS[k.deck].main }}>
                      {k.deck} · {claudeNotes?.choice === selected.id && claudeNotes.clipLabels[i] ? claudeNotes.clipLabels[i] : k.label}
                    </td>
                    <td className="pr-3 py-1 font-mono" title={`${(k.lengthBeats / 4).toFixed(2)} bars of audio: the clip ends where the singing ends`}>
                      {Math.floor(k.srcBar + (k.startBeat % 4 !== 0 ? 1 : 0)) + 1}–{Math.floor(k.srcBar + (k.startBeat % 4 !== 0 ? 1 : 0)) + k.slotBars}
                      {k.mode === "layer" && Math.abs(k.lengthBeats - k.slotBars * 4) > 0.3 ? <span className="text-muted"> · to phrase end</span> : null}
                    </td>
                    <td className="pr-3 py-1">{k.stem}</td>
                    <td className="pr-3 py-1">{k.mode === "swap" ? "swaps beat" : "layers"}</td>
                    <td className="pr-3 py-1 font-mono" style={{ color: k.fit >= 0.7 ? "#30d158" : k.fit >= 0.5 ? "#ffd60a" : "#ff6b61" }}>
                      {k.mode === "swap" ? "—" : `${Math.round(k.fit * 100)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {claudeNotes?.choice === selected.id && claudeNotes.tips.length > 0 && (
            <ul className="text-[0.75rem] text-muted list-disc pl-5 space-y-1">
              {claudeNotes.tips.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          )}
          {claudeNotes?.stemAdvice && claudeNotes.stemAdvice.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {claudeNotes.stemAdvice.map((a, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 text-[12px] rounded-[10px] inset px-3 py-2">
                  <Icon name="sparkles" size={12} />
                  <span>
                    <b>Deck {a.deck}</b>: {a.reason}
                  </span>
                  <div className="flex-1" />
                  <button className="btn btn-xs" disabled={!config.stems || decks[a.deck].stemBusy} onClick={() => void separateAI(a.deck, a.variant)}>
                    Separate with {a.variant === "htdemucs_ft" ? "fine-tuned" : a.variant === "htdemucs_6s" ? "6-stem" : "standard"} Demucs
                  </button>
                </div>
              ))}
            </div>
          )}
          {claudePlan?.notes && claudePlan.notes.length > 0 && (
            <div className="text-[11.5px] text-warn/90 leading-relaxed">
              {claudePlan.notes.map((n, i) => (
                <div key={i}>· {n}</div>
              ))}
            </div>
          )}

          {/* Alternatives */}
          {candidates.length > 1 && (
            <div className={`flex flex-col gap-1.5 ${claudeBusy ? "thinking-dim" : ""}`}>
              <span className="label">Alternatives</span>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {candidates.slice(0, 6).map((c) => (
                  <CandidateChip key={c.id} c={c} active={c.id === selected.id} onClick={() => selectCandidate(c.id)} />
                ))}
              </div>
            </div>
          )}

          {/* Refinement */}
          <div className={`flex flex-wrap items-center gap-1.5 ${claudeBusy ? "thinking-dim" : ""}`}>
            <span className="label mr-1">Adjust</span>
            <Chip
              on={constraints.vocals === "both"}
              title="Let the two singers take turns: the other song's hook, then the foundation song's own vocal over its own instrumental. Never both at once."
              onClick={() => quick({ vocals: constraints.vocals === "both" ? "one" : "both" }, constraints.vocals === "both" ? "only one vocal" : "use vocals from both songs, taking turns")}
            >
              Both vocals
            </Chip>
            <Chip on={constraints.vocalEntryBar === 4} onClick={() => (constraints.vocalEntryBar === 4 ? quick({ vocalEntryBar: undefined }, "let the vocal enter where it fits best") : quick({ vocalEntryBar: 4 }, "bring the vocal in earlier"))}>
              Vocal earlier
            </Chip>
            <Chip on={constraints.energy === "higher"} onClick={() => (constraints.energy === "higher" ? quick({ energy: undefined }, "normal energy") : quick({ energy: "higher" }, "more energy"))}>
              More energy
            </Chip>
            <button className="btn btn-xs" onClick={() => quick({ lengthBars: Math.max(24, (selected.lengthBars || 32) + 16) }, "make it longer")}>Longer</button>
            <button className="btn btn-xs" onClick={() => quick({ lengthBars: Math.max(16, (selected.lengthBars || 32) - 12) }, "make it shorter")}>Shorter</button>
            <Chip on={constraints.foundation !== undefined} title={constraints.foundation ? `Beat pinned to ${decks[constraints.foundation].name}` : "Swap which song carries the beat"} onClick={() => (constraints.foundation ? quick({ foundation: undefined }, "let the planner choose which song carries the beat") : quick({ foundation: selected.vocalDeck }, "swap the roles of the two songs"))}>
              Swap roles
            </Chip>
            <Chip on={constraints.maxShift === 0} onClick={() => (constraints.maxShift === 0 ? quick({ maxShift: undefined }, "pitch shifting allowed again") : quick({ maxShift: 0 }, "no pitch shifting"))}>
              No pitch shift
            </Chip>
            <button className="btn btn-xs" onClick={() => quick({ hookBars: selected.clips[0]?.lengthBeats >= 32 ? 4 : 16 }, "change the hook length")}>{selected.clips[0]?.lengthBeats >= 32 ? "4-bar hooks" : "16-bar hooks"}</button>
            {Object.values(constraints).some((v) => v !== undefined) && (
              <button className="btn btn-xs text-muted" onClick={() => quick(RESET, "start over with no constraints")} title="Clear every adjustment">
                Reset
              </button>
            )}
          </div>
          {config.ai && (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!instruction.trim() || claudeBusy) return;
                void refinePlan(instruction);
                setInstruction("");
              }}
            >
              <input
                className="flex-1 h-[30px] rounded-[8px] border border-white/[0.12] bg-black/30 px-3 text-[12.5px] outline-none focus:border-[#7c6cff]"
                placeholder={planHistory.length ? "Refine again…" : "Tell Claude what to change… e.g. “make the drop hit harder”, “use the second verse instead”"}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                disabled={claudeBusy}
              />
              <button className="btn btn-sm" type="submit" disabled={claudeBusy || !instruction.trim()}>
                {claudeBusy ? <span className="h-3 w-3 rounded-full border-2 border-white/30 border-t-white animate-spin" /> : <Icon name="wand" size={12} />} Revise
              </button>
            </form>
          )}
          {planHistory.length > 0 && <div className="text-[11px] text-muted">Revisions: {planHistory.map((h) => `“${h.instruction}”`).join(" → ")}</div>}
        </div>
      )}

      {suggestions.length > 0 && !selected && (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {suggestions.map((s) => {
            const deckId = s.action && "deckId" in s.action ? s.action.deckId : null;
            const accent = deckId ? DECK_COLORS[deckId].main : "var(--accent)";
            return (
              <div key={s.id} className="rounded-[12px] inset p-3 flex gap-3 fade-in">
                <div className="h-8 w-8 rounded-[8px] grid place-items-center shrink-0" style={{ background: `${accent}1f`, color: accent }}>
                  <Icon name={KIND_ICON[s.kind] ?? "check"} size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold leading-snug tracking-[-0.01em]">{s.title}</div>
                  <div className="text-[12px] text-text-2 mt-1 leading-relaxed">{s.detail}</div>
                  {s.action && (
                    <button className="btn btn-sm mt-2.5" onClick={() => applySuggestion(s.action!)}>
                      Apply
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CandidateChip({ c, active, onClick }: { c: PlanCandidate; active: boolean; onClick: () => void }) {
  const pct = Math.round(c.score * 100);
  return (
    <button className="shrink-0 rounded-[10px] inset px-3 py-2 text-left hover:bg-white/[0.06] transition-colors" style={active ? { borderColor: "rgba(124,108,255,0.7)", boxShadow: "0 0 0 1px rgba(124,108,255,0.3)" } : undefined} onClick={onClick}>
      <div className="text-[12px] font-medium">
        {TEMPLATE_NAME[c.template]} <span className="text-muted font-mono tabular-nums ml-1">{pct}</span>
      </div>
      <div className="text-[10.5px] text-muted font-mono tabular-nums">
        from bar {c.foundation.startBar + 1} · {c.semitones ? `${c.semitones > 0 ? "+" : ""}${c.semitones} st` : "0 st"} · fit {Math.round(c.breakdown.harmony * 100)}%
      </div>
    </button>
  );
}
