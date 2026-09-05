import { processChannels, processChannelsFormant } from "@/lib/audio/stretch";
import { quickStems } from "@/lib/audio/quickStems";

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

export type DspRequest =
  | { type: "stretch"; id: string; channels: Float32Array[]; sampleRate: number; ratio: number; semitones: number; preserveFormants?: boolean }
  | { type: "quickStems"; id: string; channels: Float32Array[]; sampleRate: number };

ctx.onmessage = (e: MessageEvent<DspRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === "stretch") {
      const out = (msg.preserveFormants ? processChannelsFormant : processChannels)(msg.channels, {
        ratio: msg.ratio,
        semitones: msg.semitones,
        sampleRate: msg.sampleRate,
        onProgress: (v) => ctx.postMessage({ type: "progress", id: msg.id, value: v }),
      });
      // subarray views share a buffer; copy so we can transfer cleanly
      const copies = out.map((c) => c.slice());
      ctx.postMessage({ type: "result", id: msg.id, channels: copies }, copies.map((c) => c.buffer));
    } else if (msg.type === "quickStems") {
      const res = quickStems(msg.channels, msg.sampleRate);
      const all = [...res.instrumental, ...res.vocals];
      ctx.postMessage({ type: "result", id: msg.id, instrumental: res.instrumental, vocals: res.vocals }, all.map((c) => c.buffer));
    }
  } catch (err) {
    ctx.postMessage({ type: "error", id: msg.id, message: (err as Error).message });
  }
};
