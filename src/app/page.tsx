"use client";
import dynamic from "next/dynamic";

const Studio = dynamic(() => import("@/components/Studio"), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center text-muted text-sm">Loading studio…</div>
  ),
});

export default function Page() {
  return <Studio />;
}
