// Icons drawn on the stack's own 16x16 pixel grid: hard edges, no curves, one
// weight throughout. `shapeRendering="crispEdges"` keeps them from softening
// into a modern stroke set at any scale.

type IconProps = { className?: string };

const base = "h-4 w-4 shrink-0";

/** The stack itself: three cards seen edge-on. */
export function StackIcon({ className = "" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`${base} ${className}`}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden
    >
      <path d="M1 4h14v2H1zM2 7h12v2H2zM3 10h10v2H3z" />
    </svg>
  );
}

/** Grid view: the whole stack dealt out at once. */
export function GridIcon({ className = "" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`${base} ${className}`}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden
    >
      <path d="M2 2h4v4H2zM10 2h4v4h-4zM2 10h4v4H2zM10 10h4v4h-4z" />
    </svg>
  );
}

export function ArrowLeftIcon({ className = "" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`${base} ${className}`}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden
    >
      <path d="M7 3h2v2H7zM5 5h2v2H5zM3 7h2v2H3zM5 9h2v2H5zM7 11h2v2H7zM5 7h9v2H5z" />
    </svg>
  );
}

export function ArrowRightIcon({ className = "" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`${base} ${className}`}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden
    >
      <path d="M7 3h2v2H7zM9 5h2v2H9zM11 7h2v2h-2zM9 9h2v2H9zM7 11h2v2H7zM2 7h9v2H2z" />
    </svg>
  );
}

/** Find: a boxy pixel magnifier, no smooth circle anywhere. */
export function FindIcon({ className = "" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`${base} ${className}`}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden
    >
      <path d="M3 2h7v2H3zM2 3h2v6H2zM9 3h2v6H9zM3 8h7v2H3zM10 10h2v2h-2zM12 12h2v2h-2z" />
    </svg>
  );
}

/** A single card, used for the message/thread register. */
export function CardIcon({ className = "" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`${base} ${className}`}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden
    >
      <path d="M2 2h12v2H2zM2 4h2v10H2zM12 4h2v10h-2zM2 12h12v2H2zM5 6h6v1H5zM5 8h6v1H5zM5 10h4v1H5z" />
    </svg>
  );
}

/** Paint: the tool that makes reading and writing one mode. */
export function PaintIcon({ className = "" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`${base} ${className}`}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden
    >
      <path d="M11 2h3v3h-3zM9 4h2v2H9zM7 6h2v2H7zM5 8h2v2H5zM3 10h2v2H3zM2 12h2v2H2z" />
    </svg>
  );
}

/** Sync: two cards trading places. */
export function SyncIcon({ className = "" }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`${base} ${className}`}
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden
    >
      <path d="M3 3h8v2H3zM3 5h2v2H3zM9 1h2v2H9zM9 5h2v2H9zM5 9h8v2H5zM11 11h2v2h-2zM5 9h2v2H5zM5 13h2v2H5z" />
    </svg>
  );
}
