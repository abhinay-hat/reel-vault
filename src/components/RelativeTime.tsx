"use client";

import { useEffect, useState } from "react";

// "3 hr ago" depends on *when* it is rendered, so computing it during the server
// render guarantees a hydration mismatch (server clock vs. client clock, and
// server locale vs. browser locale). Instead: render a stable absolute date on
// the server and through first paint, then upgrade to a relative label once the
// component is on the client, where both the clock and the locale are real.

const ABSOLUTE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60_000],
  ["month", 30 * 24 * 60 * 60_000],
  ["week", 7 * 24 * 60 * 60_000],
  ["day", 24 * 60 * 60_000],
  ["hour", 60 * 60_000],
  ["minute", 60_000],
];

function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const elapsed = then - Date.now();
  const rtf = new Intl.RelativeTimeFormat(navigator.language, {
    numeric: "auto",
    style: "short",
  });

  for (const [unit, ms] of UNITS) {
    if (Math.abs(elapsed) >= ms) {
      return rtf.format(Math.round(elapsed / ms), unit);
    }
  }
  return rtf.format(0, "minute");
}

export default function RelativeTime({
  iso,
  fallback = "",
  className,
}: {
  iso: string | null;
  /** Shown when there is no timestamp at all, e.g. an empty thread. */
  fallback?: string;
  className?: string;
}) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!iso) return;
    setLabel(relative(iso));
  }, [iso]);

  if (!iso) return <span className={className}>{fallback}</span>;

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  return (
    <time dateTime={date.toISOString()} className={className} suppressHydrationWarning>
      {label ?? ABSOLUTE.format(date)}
    </time>
  );
}
