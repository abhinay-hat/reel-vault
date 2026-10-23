import type { ElementType, ReactNode } from "react";

/**
 * One treatment for every empty, not-found, and failed-load state: a card with
 * nothing on it, which in this world is a legible object rather than an error.
 * `titleAs` is "h1" on standalone not-found pages and "p" under a page heading.
 */
export function EmptyState({
  title,
  description,
  children,
  titleAs: Title = "p",
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  titleAs?: ElementType;
}) {
  return (
    <div className="hand bg-paper">
      <div className="stipple-1 border-b-2 border-ink px-4 py-1.5">
        <p className="font-display text-[12px] tracking-wide">EMPTY CARD</p>
      </div>
      <div className="px-6 py-12 text-center">
        <Title className="font-display text-[20px] leading-tight text-ink">
          {title}
        </Title>
        {description ? (
          <p className="mx-auto mt-3 max-w-[52ch] text-[13px] leading-relaxed text-ink">
            {description}
          </p>
        ) : null}
        {children ? (
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            {children}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default EmptyState;
