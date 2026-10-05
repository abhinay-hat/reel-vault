import Link from "next/link";
import type { Item } from "@/lib/db";
import CardThumb from "@/components/CardThumb";

/**
 * One card in the stack.
 *
 * The photograph is pasted on at full colour — it is the only signal this vault
 * carries at 100% coverage, so the 1-bit rule yields to it. Everything around
 * it is ink and paper.
 *
 * A card nobody has described does not get filler: it shows its ruled writing
 * area, empty, exactly as it is. Half this vault looks blank because half of it
 * is blank, and the stack says so.
 */
export function ItemCard({
  item,
  index,
  priority = false,
}: {
  item: Item;
  /** Position in the stack; cards are numbered the way a stack is. */
  index?: number;
  priority?: boolean;
}) {
  const described = Boolean(item.summary && item.summary.trim());
  const fromDM = item.origin === "dm_shared";

  return (
    <Link
      href={`/item/${item.id}`}
      className="group block focus:outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink"
    >
      <article className="hand flex h-full flex-col bg-paper group-hover:bg-ink">
        <div className="flex items-center justify-between gap-2 border-b-2 border-ink px-2 py-1 group-hover:border-paper">
          <span
            className={`font-display text-[10px] leading-none tracking-wide ${
              fromDM
                ? "bg-ink px-1 py-0.5 text-paper group-hover:bg-paper group-hover:text-ink"
                : "text-ink group-hover:text-paper"
            }`}
          >
            {fromDM ? "DM" : "SAVED"}
          </span>
          {index !== undefined ? (
            <span className="tabular text-[10px] text-ink group-hover:text-paper">
              {index}
            </span>
          ) : null}
        </div>

        <div className="aspect-[3/4] w-full overflow-hidden border-b-2 border-ink bg-paper group-hover:border-paper">
          <CardThumb
            src={item.poster}
            priority={priority}
            hasClip={Boolean(item.clip)}
            expired={Boolean(item.thumbnail) && !item.poster}
          />
        </div>

        <div className="flex flex-1 flex-col gap-1 px-2 py-2">
          {described ? (
            <>
              <h3 className="font-display line-clamp-2 text-[13px] leading-tight text-ink group-hover:text-paper">
                {item.title || "Untitled card"}
              </h3>
              <p className="line-clamp-2 text-[12px] leading-snug text-ink group-hover:text-paper">
                {item.summary}
              </p>
            </>
          ) : (
            // The empty writing area. Three ruled lines and a stated condition:
            // this card exists and nobody has written on it.
            <>
              <span className="font-display text-[10px] tracking-wide text-ink group-hover:text-paper">
                BLANK
              </span>
              <div
                aria-label="Not described yet"
                role="img"
                className="mt-0.5 flex flex-col gap-1.5"
              >
                <span className="block h-px w-full bg-ink group-hover:bg-paper" />
                <span className="block h-px w-full bg-ink group-hover:bg-paper" />
                <span className="block h-px w-2/3 bg-ink group-hover:bg-paper" />
              </div>
            </>
          )}
        </div>
      </article>
    </Link>
  );
}
