import { analyzeSong } from "@/lib/audio/analysis";

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

export interface AnalysisRequest {
  type: "analyze";
  id: string;
  mono: Float32Array;
  sampleRate: number;
}

ctx.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const { id, mono, sampleRate } = e.data;
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
