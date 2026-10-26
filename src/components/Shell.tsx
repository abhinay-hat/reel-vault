"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MenuBar, StackContents } from "@/components/NavLinks";
import StackState from "@/components/StackState";
import Trail from "@/components/Trail";
import { StackIcon } from "@/components/icons";
import { BUTTON_SMALL } from "@/components/stack";

/**
 * The stack's frame: a menu bar across the top, the state line under it, the
 * contents rail down the left on wide screens, and the open card in the middle.
 *
 * Elevation is hairline seams and inversion, never shadow: panels are divided
 * by 2px rules and the active thing is filled solid black.
 */
export function Shell({
  children,
  cardCount = null,
}: {
  children: React.ReactNode;
  /** Shown in the rail header when the caller already knows the total. */
  cardCount?: number | null;
}) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch {
      /* clear UI anyway */
    }
    router.push("/login");
    setLoggingOut(false);
  }

  return (
    <div className="flex min-h-full flex-col">
      <a
        href="#card"
        className="font-display sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-ink focus:px-3 focus:py-1.5 focus:text-[14px] focus:text-paper"
      >
        Skip to the card
      </a>

      <header className="sticky top-0 z-20 border-b-2 border-ink bg-paper">
        <div className="flex items-center justify-between gap-4 border-b-2 border-ink px-4 py-1.5">
          <Link
            href="/"
            translate="no"
            className="font-display flex shrink-0 items-center gap-2 whitespace-nowrap text-[16px] hover:bg-ink hover:text-paper"
          >
            <StackIcon />
            Reel Vault
          </Link>
          <div className="flex items-center gap-2">
            <MenuBar />
            <button
              type="button"
              className={BUTTON_SMALL}
              disabled={loggingOut}
              onClick={() => void logout()}
            >
              {loggingOut ? "…" : "Log out"}
            </button>
          </div>
        </div>
        <StackState />
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-6 px-4 py-6 lg:gap-8 lg:py-8">
        <aside className="hidden w-56 shrink-0 lg:block">
          <div className="sticky top-32">
            <StackContents count={cardCount} />
          </div>
        </aside>

        <main id="card" className="min-w-0 flex-1">
          {children}
        </main>
      </div>

      {/* The page ends on a dark band: the deepest step of the stipple ramp,
          so the scroll closes on an anchor instead of trailing off on paper. */}
      <footer className="stipple-5 mt-8 border-t-2 border-ink text-paper">
        <div className="mx-auto max-w-6xl space-y-3 px-4 py-5">
          <Trail />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-dotted border-paper/40 pt-3">
            <p className="font-display text-[12px]">
              Every card stays on this machine.
            </p>
            <p className="text-[12px]">
              <Link href="/add" className="underline">
                Add
              </Link>
              {" · "}
              <Link href="/ingest" className="underline">
                Ingest
              </Link>
              {" · "}
              <Link href="/bookmarklet" className="underline">
                Bookmarklet
              </Link>
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default Shell;
