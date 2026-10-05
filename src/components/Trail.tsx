"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * The trail: the marks this session left on the stack.
 *
 * The raise donated by the defaced-sleeve hand — a surface keeps the marks you
 * made on it rather than resetting to pristine. Cards you opened and questions
 * you asked stay on the stack, in order, so the path you took through it is
 * visible rather than forgotten the moment you navigate away.
 *
 * Local to this browser only; nothing about your route through the vault is
 * written to the database or sent anywhere.
 */

const KEY = "rv.trail.v1";
const LIMIT = 12;

export type Mark = { href: string; label: string };

/** Record a mark. Safe to call during render effects; de-duplicates in place. */
export function leaveMark(mark: Mark) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(KEY);
    const marks: Mark[] = raw ? JSON.parse(raw) : [];
    const next = [mark, ...marks.filter((m) => m.href !== mark.href)].slice(0, LIMIT);
    window.localStorage.setItem(KEY, JSON.stringify(next));
    window.dispatchEvent(new Event("rv:trail"));
  } catch {
    // A full or disabled localStorage costs the trail, never the page.
  }
}

export default function Trail() {
  const [marks, setMarks] = useState<Mark[]>([]);

  useEffect(() => {
    const read = () => {
      try {
        const raw = window.localStorage.getItem(KEY);
        setMarks(raw ? JSON.parse(raw) : []);
      } catch {
        setMarks([]);
      }
    };
    read();
    window.addEventListener("rv:trail", read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener("rv:trail", read);
      window.removeEventListener("storage", read);
    };
  }, []);

  if (marks.length === 0) return null;

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="font-display text-[11px] tracking-wide">TRAIL</span>
      {marks.map((m, i) => (
        <span key={m.href} className="flex items-baseline gap-2">
          {i > 0 ? (
            <span aria-hidden className="opacity-50">
              ·
            </span>
          ) : null}
          <Link
            href={m.href}
            className="max-w-[22ch] truncate text-[11px] underline decoration-1 underline-offset-2 hover:bg-paper hover:text-ink hover:no-underline"
          >
            {m.label}
          </Link>
        </span>
      ))}
      <button
        type="button"
        onClick={() => {
          try {
            window.localStorage.removeItem(KEY);
          } catch {
            /* ignore */
          }
          window.dispatchEvent(new Event("rv:trail"));
        }}
        className="font-display ml-2 text-[11px] underline decoration-1 underline-offset-2 hover:bg-paper hover:text-ink hover:no-underline"
      >
        Wipe
      </button>
    </div>
  );
}
