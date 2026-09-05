import type { SongAnalysis, AnalysisProgress } from "./audio/analysis";
import type { Section } from "./audio/sections";

let seq = 0;
const nextId = () => `job${++seq}`;

export function runAnalysis(
  mono: Float32Array,
  sampleRate: number,
  onProgress?: (p: AnalysisProgress) => void,
): Promise<SongAnalysis> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/analysis.worker.ts", import.meta.url));
    const id = nextId();
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.type === "progress") onProgress?.({ stage: msg.stage, value: msg.value });
      else if (msg.type === "result") {
        worker.terminate();
        resolve(msg.result as SongAnalysis);
      } else if (msg.type === "error") {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "analysis worker failed"));
    };
    worker.postMessage({ type: "analyze", id, mono, sampleRate }, [mono.buffer]);
  });
}

export function runStretch(
  channels: Float32Array[],
  sampleRate: number,
  ratio: number,
  semitones: number,
  onProgress?: (v: number) => void,
  preserveFormants = false,
): Promise<Float32Array[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/dsp.worker.ts", import.meta.url));
    const id = nextId();
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.type === "progress") onProgress?.(msg.value);
      else if (msg.type === "result") {
        worker.terminate();
        resolve(msg.channels as Float32Array[]);
      } else if (msg.type === "error") {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "dsp worker failed"));
    };
    worker.postMessage(
      { type: "stretch", id, channels, sampleRate, ratio, semitones, preserveFormants },
      channels.map((c) => c.buffer),
    );
  });
}

export function runQuickStems(
  channels: Float32Array[],
  sampleRate: number,
): Promise<{ instrumental: Float32Array[]; vocals: Float32Array[] }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/dsp.worker.ts", import.meta.url));
    const id = nextId();
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.type === "result") {
        worker.terminate();
        resolve({ instrumental: msg.instrumental, vocals: msg.vocals });
      } else if (msg.type === "error") {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "dsp worker failed"));
    };
    worker.postMessage({ type: "quickStems", id, channels, sampleRate }, channels.map((c) => c.buffer));
  });
}

export function runSections(mono: Float32Array, sampleRate: number, grid: { firstDownbeat: number; beatInterval: number; totalBars: number }): Promise<Section[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/analysis.worker.ts", import.meta.url));
    const id = nextId();
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.type === "result") {
        worker.terminate();
        resolve(msg.sections as Section[]);
      } else if (msg.type === "error") {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "sections worker failed"));
    };
    worker.postMessage({ type: "sections", id, mono, sampleRate, grid }, [mono.buffer]);
  });
}
