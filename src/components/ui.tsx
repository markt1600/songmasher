"use client";
import type { ReactNode } from "react";

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "play":
      return <svg {...common} fill="currentColor" stroke="none"><path d="M7 4.5v15l12-7.5z" /></svg>;
    case "pause":
      return <svg {...common} fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>;
    case "stop":
      return <svg {...common} fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>;
    case "loop":
      return <svg {...common}><path d="M17 2l4 4-4 4" /><path d="M3 11V9a4 4 0 014-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v2a4 4 0 01-4 4H3" /></svg>;
    case "download":
      return <svg {...common}><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 21h16" /></svg>;
    case "upload":
      return <svg {...common}><path d="M12 21V9" /><path d="M7 14l5-5 5 5" /><path d="M4 3h16" /></svg>;
    case "x":
      return <svg {...common}><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>;
    case "plus":
      return <svg {...common}><path d="M12 5v14" /><path d="M5 12h14" /></svg>;
    case "minus":
      return <svg {...common}><path d="M5 12h14" /></svg>;
    case "repeat":
      return <svg {...common}><rect x="3" y="7" width="8" height="10" rx="2" /><rect x="13" y="7" width="8" height="10" rx="2" strokeDasharray="3 2" /></svg>;
    case "trash":
      return <svg {...common}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></svg>;
    case "sparkles":
      return <svg {...common}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" /></svg>;
    case "anchor":
      return <svg {...common}><circle cx="12" cy="5" r="2.5" /><path d="M12 7.5V21" /><path d="M5 12H2a10 10 0 0020 0h-3" /></svg>;
    case "scissors":
      return <svg {...common}><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4L8.1 15.9" /><path d="M14.5 14.5L20 20" /><path d="M8.1 8.1L12 12" /></svg>;
    case "chev-left":
      return <svg {...common}><path d="M15 6l-6 6 6 6" /></svg>;
    case "chev-right":
      return <svg {...common}><path d="M9 6l6 6-6 6" /></svg>;
    case "check":
      return <svg {...common}><path d="M5 13l4 4L19 7" /></svg>;
    case "music":
      return <svg {...common}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>;
    case "wand":
      return <svg {...common}><path d="M15 4V2" /><path d="M15 16v-2" /><path d="M8 9h2" /><path d="M20 9h2" /><path d="M17.8 11.8L19 13" /><path d="M15 9h0" /><path d="M17.8 6.2L19 5" /><path d="M3 21l9-9" /><path d="M12.2 6.2L11 5" /></svg>;
    case "zoom-in":
      return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /><path d="M11 8v6" /><path d="M8 11h6" /></svg>;
    case "zoom-out":
      return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /><path d="M8 11h6" /></svg>;
    default:
      return null;
  }
}

export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  suffix,
  title,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  suffix?: string;
  title?: string;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="inline-flex items-center h-[30px] rounded-[8px] border border-white/[0.12] bg-gradient-to-b from-white/[0.11] to-white/[0.07] shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_1px_2px_rgba(0,0,0,0.35)]" title={title}>
      <button className="h-full w-7 grid place-items-center text-text-2 hover:text-text active:bg-black/20 disabled:opacity-30 rounded-l-[7px]" onClick={() => onChange(clamp(value - step))} disabled={value <= min} aria-label="decrease">
        <Icon name="minus" size={11} />
      </button>
      <span className="font-mono text-[12px] tabular-nums min-w-[44px] text-center px-1 border-x border-white/[0.08] h-full inline-flex items-center justify-center bg-black/20">
        {format ? format(value) : value}
        {suffix && <span className="text-muted text-[10px] ml-0.5">{suffix}</span>}
      </span>
      <button className="h-full w-7 grid place-items-center text-text-2 hover:text-text active:bg-black/20 disabled:opacity-30 rounded-r-[7px]" onClick={() => onChange(clamp(value + step))} disabled={value >= max} aria-label="increase">
        <Icon name="plus" size={11} />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} data-active={o.value === value} disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <span className="label">{label}</span>
      {children}
    </div>
  );
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
}
