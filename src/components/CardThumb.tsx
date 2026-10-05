"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The photograph pasted onto the card.
 *
 * Instagram's thumbnail URLs are signed and they expire, so a card saved months
 * ago now answers 403. That is not a loading state and it will not recover, so
 * the card says so: a stipple field with the picture's own frame drawn empty.
 * The alternative, a browser's broken-image glyph, is the one thing in this
 * stack that would not be drawn by us.
 */
export default function CardThumb({
  src,
  alt = "",
  priority = false,
  className = "",
  hasClip = false,
  expired = false,
}: {
  src: string | null;
  alt?: string;
  priority?: boolean;
  className?: string;
  /** Draws the play mark: this card holds a video, not only a still. */
  hasClip?: boolean;
  /** The card had a picture and its Instagram link has lapsed. */
  expired?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const img = useRef<HTMLImageElement>(null);

  // The server-rendered <img> starts loading before React hydrates, so a URL
  // that 403s has already failed by the time onError could be attached and the
  // event is never replayed. Ask the element directly on mount instead: a
  // finished load with no intrinsic width is a broken image.
  useEffect(() => {
    const el = img.current;
    if (el && el.complete && el.naturalWidth === 0) setFailed(true);
  }, [src]);

  // Three distinct states, and the card should not conflate them: a picture
  // that never existed, one whose link has lapsed, and one that failed just now.
  const gone = expired || failed;

  if (!src || gone) {
    return (
      <div
        role="img"
        aria-label={gone ? "Picture expired" : "No picture"}
        className={`stipple-2 relative flex h-full w-full items-center justify-center ${className}`}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-6 w-6"
          fill="currentColor"
          shapeRendering="crispEdges"
          aria-hidden
        >
          <path d="M2 4h20v2H2zM2 6h2v12H2zM20 6h2v12h-2zM2 18h20v2H2zM6 9h3v3H6zM11 13h4v3h-4zM6 15h3v2H6z" />
        </svg>
        <span className="font-display absolute bottom-1 left-0 right-0 bg-paper px-1 text-center text-[9px] leading-tight">
          {gone ? "PICTURE EXPIRED" : "NO PICTURE"}
        </span>
      </div>
    );
  }

  return (
    <span className="relative block h-full w-full">
      {hasClip ? (
        <span
          aria-hidden
          className="absolute bottom-1 right-1 z-10 border-2 border-ink bg-paper px-1 py-0.5"
        >
          <svg
            viewBox="0 0 8 8"
            className="h-2 w-2"
            fill="currentColor"
            shapeRendering="crispEdges"
            aria-hidden
          >
            <path d="M1 0h1v8H1zM2 1h1v6H2zM3 2h1v4H3zM4 3h1v2H4z" />
          </svg>
        </span>
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
      ref={img}
      src={src}
      alt={alt}
      width={640}
      height={960}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
      decoding="async"
        onError={() => setFailed(true)}
        className={`h-full w-full object-cover ${className}`}
      />
    </span>
  );
}
