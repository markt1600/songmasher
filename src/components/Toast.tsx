"use client";
import { useStore } from "@/lib/store";

export default function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div className="fixed bottom-6 left-1/2 z-50 rise-in rounded-xl border border-white/10 bg-[#1c1c22]/95 backdrop-blur-xl px-4 py-2.5 text-[13px] shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
      {toast}
    </div>
  );
}
