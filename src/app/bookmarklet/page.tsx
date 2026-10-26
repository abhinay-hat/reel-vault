"use client";

import { useEffect, useMemo, useRef } from "react";
import Shell from "@/components/Shell";
import { PANEL, PANEL_HEADER } from "@/components/stack";

export default function BookmarkletPage() {
  const origin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:3210";

  const code = useMemo(
    () =>
      "javascript:(function(){window.open(" +
      JSON.stringify(`${origin}/add?url=`) +
      "+encodeURIComponent(location.href),'_blank')})();",
    [origin],
  );

  // React 19 rewrites javascript: hrefs passed as props into a throwing stub,
  // which would make the dragged bookmark useless. Set the attribute directly.
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    link.current?.setAttribute("href", code);
  }, [code]);

  return (
    <Shell>
      <div className="mx-auto max-w-xl space-y-4 pb-10">
        <div className={PANEL}>
          <div className={PANEL_HEADER}>
            <span>Bookmarklet</span>
            <span>DESKTOP</span>
          </div>
          <div className="space-y-4 px-4 py-5">
            <div className="space-y-1.5">
              <h1 className="font-display text-[18px] leading-tight">
                Desktop bookmarklet
              </h1>
              <p className="text-[13px] leading-relaxed">
                Drag the button below onto your bookmarks bar. On any reel or article
                page, click it to open Reel Vault&apos;s add flow with that URL.
              </p>
            </div>

            <a
              ref={link}
              href="#"
              onClick={(e) => e.preventDefault()}
              className="font-display hand inline-flex bg-ink px-4 py-2 text-[14px] text-paper"
            >
              + Reel Vault
            </a>

            <p className="text-[12px] leading-relaxed">
              Or create a bookmark by hand and paste this as its URL:
            </p>
            <textarea
              readOnly
              rows={3}
              value={code}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full break-all font-mono text-[12px]"
            />

            <p className="text-[12px] leading-relaxed opacity-70">
              Uses this origin: <code>{origin}</code>. Re-open this page from the
              host you actually use (LAN IP or tunnel) so the bookmarklet points at
              the right place.
            </p>
          </div>
        </div>
      </div>
    </Shell>
  );
}
