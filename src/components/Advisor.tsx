"use client";
import { useState } from "react";
import { useStore } from "@/lib/store";
import { DECK_COLORS } from "@/lib/types";
import { Icon } from "./ui";

const KIND_ICON: Record<string, string> = { foundation: "anchor", tempo: "loop", key: "music", hook: "scissors", verse: "scissors", beat: "anchor", info: "check" };

export default function Advisor() {
  const suggestions = useStore((s) => s.suggestions);
  const config = useStore((s) => s.config);
  const decks = useStore((s) => s.decks);
  const claudePlan = useStore((s) => s.claudePlan);
  const claudeBusy = useStore((s) => s.claudeBusy);
  const claudeError = useStore((s) => s.claudeError);
  const { applySuggestion, askClaude, applyClaudePlan, refinePlan, separateAI } = useStore();
  const planHistory = useStore((s) => s.planHistory);
  const [instruction, setInstruction] = useState("");
  const bothReady = decks.A.status === "ready" && decks.B.status === "ready";
  const missingStems = (["A", "B"] as const).filter((id) => decks[id].status === "ready" && !decks[id].buffers.vocals);
  if (suggestions.length === 0 && !config.ai) return null;

  return (
    <section className="panel p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <div className="h-7 w-7 rounded-[8px] bg-gradient-to-b from-[#9d8cff] to-[#6f5cff] grid place-items-center shadow-[0_1px_0_rgba(255,255,255,0.25)_inset]">
          <Icon name="sparkles" size={13} />
        </div>
        <div className="font-semibold text-[14px] tracking-[-0.01em]">Mash advisor</div>
        <span className="text-[11.5px] text-muted">Ideas from the analysis, computed locally</span>
        <div className="flex-1" />
        <button
          className="btn btn-sm"
          disabled={!config.ai || !bothReady || claudeBusy}
          onClick={() => void askClaude()}
          title={config.ai ? "Ask Claude for a full arrangement plan based on the analysis" : "Set ANTHROPIC_API_KEY on the server to enable"}
        >
          {claudeBusy ? <span className="h-3 w-3 rounded-full border-2 border-white/30 border-t-white animate-spin" /> : <Icon name="wand" size={12} />} Ask Claude for a plan
        </button>
      </div>

      {suggestions.length > 0 && (
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

      {claudeError && <div className="text-[12px] text-[#ff6b61]">{claudeError}</div>}
      {config.ai && bothReady && missingStems.length > 0 && !claudePlan && (
        <div className="text-[11.5px] text-muted">
          Tip: separate stems on deck {missingStems.join(" and ")} first (Quick or AI). With stems, the plan can put one song&apos;s vocal over the other&apos;s instrumental; without them it can only alternate sections.
        </div>
      )}

      {claudePlan && (
        <div className="rounded-[12px] border border-[#7c6cff]/30 bg-[#7c6cff]/10 p-4 flex flex-col gap-3 fade-in">
          <div className="flex items-center gap-2">
            <Icon name="wand" size={14} />
            <div className="font-medium">Claude&apos;s plan</div>
            <div className="flex-1" />
            <button className="btn btn-sm btn-primary" onClick={applyClaudePlan}>
              Apply plan
            </button>
          </div>
          <p className="text-sm leading-relaxed">{claudePlan.summary}</p>
          <div className="grid sm:grid-cols-3 gap-2 text-[0.75rem]">
            <div className="rounded-lg bg-black/25 p-2.5">
              <div className="label mb-1">Foundation</div>
              <div>
                Deck {claudePlan.foundation.deck} · {claudePlan.foundation.stem} · from bar {claudePlan.foundation.startBar + 1}
              </div>
              <div className="text-muted mt-1">{claudePlan.foundation.reason}</div>
            </div>
            <div className="rounded-lg bg-black/25 p-2.5">
              <div className="label mb-1">Tempo</div>
              <div>{claudePlan.masterBpm} BPM</div>
            </div>
            <div className="rounded-lg bg-black/25 p-2.5">
              <div className="label mb-1">Pitch</div>
              {claudePlan.pitchShift ? (
                <>
                  <div>
                    Deck {claudePlan.pitchShift.deck}: {claudePlan.pitchShift.semitones > 0 ? "+" : ""}
                    {claudePlan.pitchShift.semitones} st
                  </div>
                  <div className="text-muted mt-1">{claudePlan.pitchShift.reason}</div>
                </>
              ) : (
                <div className="text-muted">No shift needed</div>
              )}
            </div>
          </div>
          {claudePlan.arrangement.length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-[0.72rem] w-full">
                <thead className="text-muted">
                  <tr className="text-left">
                    <th className="pr-3 py-1 font-medium">Timeline bar</th>
                    <th className="pr-3 py-1 font-medium">Deck</th>
                    <th className="pr-3 py-1 font-medium">Source bars</th>
                    <th className="pr-3 py-1 font-medium">Stem</th>
                    <th className="pr-3 py-1 font-medium">Mode</th>
                    <th className="pr-3 py-1 font-medium">Label</th>
                  </tr>
                </thead>
                <tbody>
                  {claudePlan.arrangement.map((seg, i) => (
                    <tr key={i} className="border-t border-white/8">
                      <td className="pr-3 py-1 font-mono">{seg.startBar + 1}</td>
                      <td className="pr-3 py-1" style={{ color: DECK_COLORS[seg.deck]?.main }}>
                        {seg.deck}
                      </td>
                      <td className="pr-3 py-1 font-mono">
                        {seg.srcBar + 1}–{seg.srcBar + seg.lengthBars}
                      </td>
                      <td className="pr-3 py-1">{seg.stem}</td>
                      <td className="pr-3 py-1">{seg.mode === "swap" ? "swaps beat" : "layers"}</td>
                      <td className="pr-3 py-1">{seg.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {claudePlan.notes && claudePlan.notes.length > 0 && (
            <div className="text-[11.5px] text-warn/90 leading-relaxed">
              {claudePlan.notes.map((n, i) => (
                <div key={i}>· {n}</div>
              ))}
            </div>
          )}
          {claudePlan.tips.length > 0 && (
            <ul className="text-[0.75rem] text-muted list-disc pl-5 space-y-1">
              {claudePlan.tips.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          )}
          {claudePlan.stemAdvice && claudePlan.stemAdvice.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {claudePlan.stemAdvice.map((a, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 text-[12px] rounded-[10px] inset px-3 py-2">
                  <Icon name="sparkles" size={12} />
                  <span>
                    <b>Deck {a.deck}</b>: {a.reason}
                  </span>
                  <div className="flex-1" />
                  <button className="btn btn-xs" disabled={!config.stems || decks[a.deck].stemBusy} onClick={() => void separateAI(a.deck, a.variant)} title={config.stems ? `Run Demucs ${a.variant}` : "AI stems are not configured on this deployment"}>
                    Separate with {a.variant === "htdemucs_ft" ? "fine-tuned" : a.variant === "htdemucs_6s" ? "6-stem" : "standard"} Demucs
                  </button>
                </div>
              ))}
            </div>
          )}
          <form
            className="flex items-center gap-2 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (!instruction.trim() || claudeBusy) return;
              void refinePlan(instruction);
              setInstruction("");
            }}
          >
            <input
              className="flex-1 h-[30px] rounded-[8px] border border-white/[0.12] bg-black/30 px-3 text-[12.5px] outline-none focus:border-[#7c6cff]"
              placeholder={planHistory.length ? "Refine again… e.g. “bring the vocal in earlier”" : "Refine this plan… e.g. “make the drop hit harder”, “use more of song B”, “shorter”"}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={claudeBusy}
            />
            <button className="btn btn-sm" type="submit" disabled={claudeBusy || !instruction.trim()}>
              {claudeBusy ? <span className="h-3 w-3 rounded-full border-2 border-white/30 border-t-white animate-spin" /> : <Icon name="wand" size={12} />} Revise
            </button>
          </form>
          {planHistory.length > 0 && (
            <div className="text-[11px] text-muted">
              Revisions: {planHistory.map((h) => `“${h.instruction}”`).join(" → ")}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
