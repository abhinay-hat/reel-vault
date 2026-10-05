"use client";

import { useCallback, useEffect, useState } from "react";
import type { Item } from "@/lib/db";
import Shell from "@/components/Shell";
import { ItemCard } from "@/components/ItemCard";
import { EmptyState } from "@/components/EmptyState";
import { FindIcon } from "@/components/icons";
import { BUTTON_PRIMARY, PANEL, PANEL_HEADER } from "@/components/stack";

// Ask the stack in plain words; it answers and deals the cards it found.
// Contract (Agent B): POST /api/chat { query } -> { answer: string, items: Item[] }.
type ChatResponse = { answer?: string; items?: Item[] };
type Phase = "idle" | "asking" | "answered" | "error";

export default function ChatPage() {
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [answer, setAnswer] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState("");

  const busy = phase === "asking";

  const run = useCallback(async (q: string) => {
    setPhase("asking");
    setError("");
    setAsked(q);
    setAnswer("");
    setItems([]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      if (!res.ok) {
        setError("The stack could not answer that just now. Try again in a moment.");
        setPhase("error");
        return;
      }
      const data: ChatResponse = await res.json();
      setAnswer(typeof data.answer === "string" ? data.answer : "");
      setItems(Array.isArray(data.items) ? data.items : []);
      setPhase("answered");
    } catch {
      setError("Could not reach the stack. Check that the app is running, then ask again.");
      setPhase("error");
    }
  }, []);

  // The question belongs in the URL: a good answer is worth bookmarking, and
  // back/forward should move between asks rather than leaving the page.
  useEffect(() => {
    const fromUrl = () =>
      new URLSearchParams(window.location.search).get("q")?.trim() ?? "";
    const sync = () => {
      const q = fromUrl();
      setQuery(q);
      if (q) void run(q);
      else setPhase("idle");
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [run]);

  function ask(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q || busy) return;
    // pushState fires no popstate, so drive the request directly and let the
    // listener above handle only real back/forward navigation.
    window.history.pushState(null, "", `/chat?q=${encodeURIComponent(q)}`);
    void run(q);
  }

  return (
    <Shell>
      <div className="space-y-4">
        <div className={PANEL}>
          <div className={PANEL_HEADER}>
            <span>Find</span>
            <span>plain words</span>
          </div>

          <div className="space-y-3 px-3 py-3">
            <p className="max-w-[62ch] text-[13px] leading-relaxed">
              Describe the card the way you would say it out loud. Find matches
              on what a card says about itself, so a blank card can only be
              matched on its title.
            </p>

            <form onSubmit={ask}>
              <label htmlFor="vault-ask" className="sr-only">
                Ask the stack
              </label>
              <div className="hand flex items-stretch bg-paper focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-ink">
                <span className="flex items-center border-r-2 border-ink px-2.5">
                  <FindIcon />
                </span>
                <input
                  id="vault-ask"
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="the one about kerning…"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  className="w-full bg-paper px-3 py-2 text-[14px] text-ink placeholder:text-ink placeholder:opacity-45 focus:outline-none disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={busy || !query.trim()}
                  className={`${BUTTON_PRIMARY} border-0 border-l-2 border-solid border-ink`}
                >
                  {busy ? "Asking…" : "Ask"}
                </button>
              </div>
            </form>
          </div>
        </div>

        {phase === "idle" ? (
          <EmptyState
            title="Ask the stack anything"
            description="A topic, a mood, or a half-remembered detail. The closer to how you would say it out loud, the better."
          />
        ) : null}

        {busy ? (
          <div role="status" className="hand flex items-center gap-3 bg-paper px-3 py-2.5">
            <span aria-hidden className="stipple-3 h-3 w-3 shrink-0 border border-ink" />
            <p className="text-[13px]">Reading the stack for “{asked}”…</p>
          </div>
        ) : null}

        {phase === "error" ? (
          <p role="alert" className="hand stipple-1 px-3 py-2.5 text-[13px]">
            {error}
          </p>
        ) : null}

        {phase === "answered" ? (
          <div aria-live="polite" className="dissolve space-y-4">
            {answer ? (
              <div className={PANEL}>
                <div className={PANEL_HEADER}>
                  <span>Answer</span>
                  <span className="truncate">{asked}</span>
                </div>
                <p className="max-w-[68ch] whitespace-pre-wrap px-4 py-3 text-[14px] leading-relaxed">
                  {answer}
                </p>
              </div>
            ) : null}

            {items.length > 0 ? (
              <section className="space-y-3">
                <h2 className="font-display tabular border-b-2 border-dotted border-ink pb-1.5 text-[13px] tracking-wide">
                  {items.length} {items.length === 1 ? "CARD" : "CARDS"} DEALT
                </h2>
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {items.map((item, i) => (
                    <li
                      key={item.id}
                      className="[content-visibility:auto] [contain-intrinsic-size:auto_340px]"
                    >
                      <ItemCard item={item} index={i + 1} priority={i < 8} />
                    </li>
                  ))}
                </ul>
              </section>
            ) : !answer ? (
              <EmptyState
                title="Nothing matched that"
                description="Try different words, or broaden it. The stack only knows what has been written on its cards, and most of them are still blank."
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </Shell>
  );
}
