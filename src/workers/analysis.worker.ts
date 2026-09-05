import { analyzeSong, sectionsForGrid } from "@/lib/audio/analysis";

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

export type AnalysisRequest =
  | { type: "analyze"; id: string; mono: Float32Array; sampleRate: number }
  | { type: "sections"; id: string; mono: Float32Array; sampleRate: number; grid: { firstDownbeat: number; beatInterval: number; totalBars: number } };

ctx.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const { id, mono, sampleRate } = e.data;
  if (e.data.type === "sections") {
    try {
      ctx.postMessage({ type: "result", id, sections: sectionsForGrid(mono, sampleRate, e.data.grid) });
    } catch (err) {
      ctx.postMessage({ type: "error", id, message: (err as Error).message });
    }
    return;
  }
  try {
    const result = analyzeSong(mono, sampleRate, (p) => {
      ctx.postMessage({ type: "progress", id, ...p });
    });
    ctx.postMessage({ type: "result", id, result }, [
      result.peaks.buffer,
      result.rms.buffer,
      result.barEnergy.buffer,
      result.barOnset.buffer,
      result.barVocal.buffer,
    ]);
  } catch (err) {
    ctx.postMessage({ type: "error", id, message: (err as Error).message });
  }
};
