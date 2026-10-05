"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type State = {
  items: number;
  described: number;
  conversations: number;
  lastAdded: string | null;
};

const DAY = 86_400_000;

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY));
}

/**
 * What the stack says about itself, on every screen.
 *
 * The vault is currently 0% described and months stale, and the old design
 * presented that as though it were complete. Here the undescribed remainder is
 * drawn: the ledger is a strip of card slots, filled for every described card
 * and left as an empty ruled slot for every one nobody has written on yet.
 * Absence gets the same ink as presence.
 */
export default function StackState() {
  const [state, setState] = useState<State | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/state")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("state"))))
      .then((d: State) => !cancelled && setState(d))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return (
      <p className="font-display border-b-2 border-ink px-4 py-1.5 text-[12px]">
        STACK UNREADABLE — the local database could not be opened
      </p>
    );
  }

  // Reserve the row before the numbers land so the page does not jump.
  if (!state) {
    return <div className="h-[30px] border-b-2 border-ink" aria-hidden />;
  }

  const { items, described } = state;
  const stale = daysSince(state.lastAdded);
  const undescribed = Math.max(0, items - described);

  // One slot per card up to a full row; beyond that the strip is proportional.
  const SLOTS = 48;
  const filled = items === 0 ? 0 : Math.round((described / items) * SLOTS);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b-2 border-ink px-4 py-1.5">
      <p className="font-display tabular text-[12px]">
        {items} CARDS
        <span aria-hidden className="px-2">
          ·
        </span>
        {described} DESCRIBED
        {stale !== null ? (
          <>
            <span aria-hidden className="px-2">
              ·
            </span>
            {stale === 0 ? "SYNCED TODAY" : `SYNCED ${stale} DAYS AGO`}
          </>
        ) : null}
      </p>

      {items > 0 ? (
        <div
          className="flex h-3 flex-1 basis-40 items-stretch gap-px"
          role="img"
          aria-label={`${described} of ${items} cards described`}
        >
          {Array.from({ length: SLOTS }, (_, i) => (
            <span
              key={i}
              className={
                i < filled
                  ? "flex-1 bg-ink"
                  : "stipple-1 flex-1 border-y border-ink"
              }
            />
          ))}
        </div>
      ) : null}

      {undescribed > 0 ? (
        <Link
          href="/connect"
          className="font-display text-[12px] underline decoration-2 underline-offset-2 hover:bg-ink hover:text-paper hover:no-underline"
        >
          {undescribed} blank — describe them
        </Link>
      ) : null}
    </div>
  );
}
