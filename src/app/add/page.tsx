"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Shell from "@/components/Shell";
import { BUTTON, BUTTON_PRIMARY, FIELD, PANEL, PANEL_HEADER } from "@/components/stack";
import type { Source } from "@/lib/metadata";

const URL_RE = /https?:\/\/[^\s"'<>]+/;

function extractUrl(raw: string): string {
  const m = raw.match(URL_RE);
  return m ? m[0] : raw.trim();
}

type Draft = {
  url: string;
  source: Source;
  title: string;
  author: string;
  thumbnail: string;
  summary: string;
  category: string;
  tags: string;
  notes: string;
};

export default function AddPage() {
  const params = useSearchParams();
  const router = useRouter();
  const shared = useMemo(() => {
    const url = params.get("url") ?? "";
    const text = params.get("text") ?? "";
    const title = params.get("title") ?? "";
    return extractUrl(url || text || title);
  }, [params]);

  const [url, setUrl] = useState(shared);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [error, setError] = useState("");

  async function fetchMeta(target: string) {
    const cleaned = extractUrl(target);
    if (!cleaned) {
      setError("Paste an http(s) URL first.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/metadata?url=${encodeURIComponent(cleaned)}`);
      const m = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          m.error === "url_not_allowed"
            ? "That URL is not allowed."
            : "Could not fetch metadata. Check the URL and try again.",
        );
        return;
      }
      const next: Draft = {
        url: cleaned,
        source: (m.source as Source) || "other",
        title: m.title ?? "",
        author: m.author ?? "",
        thumbnail: m.thumbnail ?? "",
        summary: "",
        category: "",
        tags: "",
        notes: "",
      };
      setDraft(next);
      setUrl(cleaned);
      // Best-effort AI fill; ignore failures.
      setEnriching(true);
      try {
        const er = await fetch("/api/enrich", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: next.title,
            caption: m.caption ?? "",
            url: cleaned,
          }),
        });
        if (er.ok) {
          const e = await er.json();
          setDraft((d) =>
            d
              ? {
                  ...d,
                  summary: e.summary || d.summary,
                  category: e.category || d.category,
                  tags: Array.isArray(e.tags) ? e.tags.join(", ") : d.tags,
                }
              : d,
          );
        }
      } catch {
        /* optional */
      } finally {
        setEnriching(false);
      }
    } catch {
      setError("Could not fetch metadata. Check the URL and try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (shared) void fetchMeta(shared);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared]);

  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: draft.url,
          source: draft.source,
          title: draft.title,
          author: draft.author || null,
          thumbnail: draft.thumbnail || null,
          summary: draft.summary || null,
          category: draft.category || "Uncategorized",
          tags: draft.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          notes: draft.notes || null,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error === "url_not_allowed" ? "That URL is not allowed." : "Save failed.");
        return;
      }
      router.push(j.id ? `/item/${j.id}` : "/");
    } catch {
      setError("Could not reach the vault.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell>
      <div className="mx-auto max-w-xl space-y-4 pb-10">
        <div className={PANEL}>
          <div className={PANEL_HEADER}>
            <span>Add</span>
            <span>{draft ? "REVIEW" : "CAPTURE"}</span>
          </div>
          <div className="space-y-4 px-4 py-5">
            <div className="space-y-1.5">
              <h1 className="font-display text-[18px] leading-tight">Add to the vault</h1>
              <p className="text-[13px] leading-relaxed">
                Paste a reel or article URL, or open this page from the Android share
                target / bookmarklet. Metadata and optional AI enrichment fill the
                form; you confirm before save.
              </p>
            </div>

            {!draft ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  className={FIELD}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.instagram.com/reel/…"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className={BUTTON_PRIMARY}
                  disabled={!url || loading}
                  onClick={() => void fetchMeta(url)}
                >
                  {loading ? "Fetching…" : "Fetch"}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="break-all text-[12px] opacity-70">{draft.url}</p>
                <label className="font-display block text-[12px] tracking-wide">TITLE</label>
                <input
                  className={FIELD}
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
                <label className="font-display block text-[12px] tracking-wide">SUMMARY</label>
                <textarea
                  className={FIELD}
                  rows={3}
                  value={draft.summary}
                  onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                  placeholder={enriching ? "Enriching…" : ""}
                />
                <label className="font-display block text-[12px] tracking-wide">CATEGORY</label>
                <input
                  className={FIELD}
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                />
                <label className="font-display block text-[12px] tracking-wide">TAGS</label>
                <input
                  className={FIELD}
                  value={draft.tags}
                  onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                  placeholder="comma separated"
                />
                <label className="font-display block text-[12px] tracking-wide">NOTES</label>
                <textarea
                  className={FIELD}
                  rows={2}
                  value={draft.notes}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                />
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    className={BUTTON_PRIMARY}
                    disabled={saving}
                    onClick={() => void save()}
                  >
                    {saving ? "Saving…" : "Save to vault"}
                  </button>
                  <button
                    type="button"
                    className={BUTTON}
                    disabled={saving}
                    onClick={() => setDraft(null)}
                  >
                    Start over
                  </button>
                </div>
              </div>
            )}

            {error ? (
              <p role="alert" className="hand stipple-1 px-2.5 py-1.5 text-[12px]">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </Shell>
  );
}
