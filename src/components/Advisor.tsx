"use client";
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
  const { applySuggestion, askClaude, applyClaudePlan } = useStore();
  const bothReady = decks.A.status === "ready" && decks.B.status === "ready";
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
                Deck {claudePlan.foundation.deck} from bar {claudePlan.foundation.startBar + 1}
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
                      <td className="pr-3 py-1">{seg.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {claudePlan.tips.length > 0 && (
            <ul className="text-[0.75rem] text-muted list-disc pl-5 space-y-1">
              {claudePlan.tips.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
