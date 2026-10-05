import Link from "next/link";
import type { CardPosition } from "@/lib/db";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GridIcon,
  StackIcon,
} from "@/components/icons";

/**
 * The stack's navigation bar: previous card, the stack, your position in it,
 * the whole deal, next card. A HyperCard stack always tells you where in the
 * stack you are, and lets you walk it without going back to the grid first.
 */
export default function CardNav({ position }: { position: CardPosition }) {
  const { index, total, previousId, nextId } = position;

  const step =
    "flex items-center justify-center px-3 py-2 hover:bg-ink hover:text-paper";
  const dead = "flex items-center justify-center px-3 py-2 opacity-30";

  return (
    <nav
      aria-label="Card navigation"
      className="hand flex items-stretch divide-x-2 divide-ink bg-paper"
    >
      {previousId ? (
        <Link href={`/item/${previousId}`} aria-label="Previous card" className={step}>
          <ArrowLeftIcon />
        </Link>
      ) : (
        <span aria-hidden className={dead}>
          <ArrowLeftIcon />
        </span>
      )}

      <Link href="/" aria-label="The whole stack" className={step}>
        <StackIcon />
      </Link>

      <p className="font-display tabular flex flex-1 items-center justify-center px-3 py-2 text-[12px]">
        {index} of {total}
      </p>

      <Link href="/" aria-label="Deal every card" className={step}>
        <GridIcon />
      </Link>

      {nextId ? (
        <Link href={`/item/${nextId}`} aria-label="Next card" className={step}>
          <ArrowRightIcon />
        </Link>
      ) : (
        <span aria-hidden className={dead}>
          <ArrowRightIcon />
        </span>
      )}
    </nav>
  );
}
