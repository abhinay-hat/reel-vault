"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import Shell from "@/components/Shell";
import { BUTTON_PRIMARY, PANEL, PANEL_HEADER } from "@/components/stack";

type IngestResult = {
  itemsAdded?: number;
  conversationsAdded?: number;
  messagesAdded?: number;
  skipped?: number;
  error?: string;
};

export default function IngestPage() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState("");

  async function onFile(file: File | null) {
    if (!file || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: buf,
      });
      const j = (await res.json().catch(() => ({}))) as IngestResult;
      if (!res.ok) {
        setError(
          j.error === "empty body"
            ? "The ZIP was empty."
            : j.error === "ingest_failed" || j.error
              ? "Ingest failed. Check that the file is an Instagram JSON export ZIP."
              : "Ingest failed.",
        );
        return;
      }
      setResult(j);
    } catch {
      setError("Could not upload the export. Is the app running?");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <Shell>
      <div className="mx-auto max-w-xl space-y-4 pb-10">
        <div className={PANEL}>
          <div className={PANEL_HEADER}>
            <span>Ingest</span>
            <span>EXPORT ZIP</span>
          </div>
          <div className="space-y-4 px-4 py-5">
            <div className="space-y-1.5">
              <h1 className="font-display text-[18px] leading-tight">
                Instagram data export
              </h1>
              <p className="text-[13px] leading-relaxed">
                Request &quot;Your activity&quot; as JSON from Instagram, download the ZIP,
                then drop it here. Saved posts, liked posts, and DM-shared links are
                imported into the local SQLite vault. Same endpoint as{" "}
                <code className="text-[12px]">POST /api/ingest</code>.
              </p>
            </div>

            <input
              ref={input}
              type="file"
              accept=".zip,application/zip"
              className="block w-full text-[13px]"
              disabled={busy}
              onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
            />

            <button
              type="button"
              className={BUTTON_PRIMARY}
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              {busy ? "Importing…" : "Choose ZIP"}
            </button>

            {error ? (
              <p role="alert" className="hand stipple-1 px-2.5 py-1.5 text-[12px]">
                {error}
              </p>
            ) : null}

            {result ? (
              <div className="hand space-y-1 px-3 py-2 text-[13px]">
                <p className="font-display text-[12px] tracking-wide">DONE</p>
                <p>
                  Items added: {result.itemsAdded ?? 0} · Conversations:{" "}
                  {result.conversationsAdded ?? 0} · Messages:{" "}
                  {result.messagesAdded ?? 0} · Skipped: {result.skipped ?? 0}
                </p>
                <p>
                  <Link href="/" className="underline">
                    Open the vault
                  </Link>
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Shell>
  );
}
