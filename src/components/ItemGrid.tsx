import Link from "next/link";
import type { Item } from "@/lib/db";
import { ItemCard } from "@/components/ItemCard";
import { EmptyState } from "@/components/EmptyState";

// The widest deal is 4 columns, so the first 8 cards cover the two rows that
// are plausibly above the fold.
const PRIORITY_COUNT = 8;

export function ItemGrid({ items }: { items: Item[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="The shoebox is empty"
        description="Connect Instagram and Reel Vault deals your saved reels, posts, and the reels traded in your DMs into the stack."
      >
        <Link
          href="/connect"
          className="font-display hand inline-flex items-center bg-ink px-4 py-2 text-[14px] text-paper hover:bg-paper hover:text-ink"
        >
          Connect Instagram
        </Link>
      </EmptyState>
    );
  }

  return (
    // The stack dealt out. Cards below the fold skip layout and paint via
    // content-visibility; the reserved size keeps the scrollbar honest.
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((item, i) => (
        <li
          key={item.id}
          className="[content-visibility:auto] [contain-intrinsic-size:auto_300px]"
        >
          <ItemCard item={item} index={i + 1} priority={i < PRIORITY_COUNT} />
        </li>
      ))}
    </ul>
  );
}
