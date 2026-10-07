"use client";

import { useState } from "react";

/**
 * Plays a reel inside the vault.
 *
 * The first play of an uncached reel goes through /api/media/clip, which pulls
 * the file from Instagram and keeps it. That takes a moment and can fail (the
 * signed link may already be dead), so this reports both instead of leaving a
 * black rectangle: silence is what made it look like playback was broken.
 */
export function InstagramEmbed({ src, title }: { src: string; title: string }) {
  // Instagram's own player: no signed link to expire, nothing stored locally.
  return (
    <iframe
      src={src}
      title={title}
      className="h-full w-full border-0 bg-paper"
      loading="lazy"
      allow="autoplay; encrypted-media; picture-in-picture"
      allowFullScreen
    />
  );
}

export default function ClipPlayer({
  src,
  poster,
  held,
  embed,
}: {
  src: string;
  poster: string | null;
  /** True when the bytes are already on this machine. */
  held: boolean;
  /** Instagram embed URL to fall back to when the file will not play. */
  embed?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  if (failed && embed) {
    return <InstagramEmbed src={embed} title="Instagram reel" />;
  }

  if (failed) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 stipple-1 px-4 text-center">
        <p className="font-display text-[12px] tracking-wide">THIS CLIP WOULD NOT PLAY</p>
        <p className="text-[13px] leading-relaxed">
          Instagram&apos;s link for it has expired. A fresh sync gets a new one.
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <video
        controls
        playsInline
        preload="metadata"
        poster={poster ?? undefined}
        onWaiting={() => setLoading(true)}
        onPlaying={() => setLoading(false)}
        onCanPlay={() => setLoading(false)}
        onError={() => {
          setLoading(false);
          setFailed(true);
        }}
        className="h-full w-full bg-ink object-contain"
      >
        <source src={src} />
        Your browser cannot play this clip.
      </video>
      {loading && !held && (
        <p className="absolute inset-x-0 bottom-10 text-center font-display text-[12px] text-paper">
          Holding this clip on your machine…
        </p>
      )}
    </div>
  );
}
