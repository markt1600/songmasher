"use client";
import { useEffect, useRef } from "react";
import { engine, useStore } from "@/lib/store";

export default function Spectrum({ width = 220, height = 40 }: { width?: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const playing = useStore((s) => s.playing);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    let raf = 0;
    const bars = 48;
    const data = new Uint8Array(512);
    const levels = new Float32Array(bars);
    const draw = () => {
      const an = engine.getAnalyser();
      ctx.clearRect(0, 0, width, height);
      if (an) an.getByteFrequencyData(data);
      const bw = width / bars;
      for (let i = 0; i < bars; i++) {
        // log-spaced bins
        const lo = Math.floor(Math.pow(data.length * 0.6, i / bars));
        const hi = Math.max(lo + 1, Math.floor(Math.pow(data.length * 0.6, (i + 1) / bars)));
        let m = 0;
        for (let k = lo; k < hi; k++) if (data[k] > m) m = data[k];
        const target = an && playing ? m / 255 : 0;
        levels[i] += (target - levels[i]) * (target > levels[i] ? 0.5 : 0.12);
        const h = Math.max(2, levels[i] * height);
        const t = i / bars;
        ctx.fillStyle = `hsla(${190 + t * 140}, 90%, ${60 + levels[i] * 20}%, ${0.35 + levels[i] * 0.65})`;
        ctx.beginPath();
        ctx.roundRect(i * bw + 1, height - h, bw - 2, h, 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [width, height, playing]);
  return <canvas ref={ref} style={{ width, height }} className="opacity-90" aria-hidden />;
}
