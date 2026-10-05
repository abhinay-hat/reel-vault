import Link from "next/link";
import { listItems, searchItems, type Item } from "@/lib/db";
import Shell from "@/components/Shell";
import SearchBar from "@/components/SearchBar";
import { ItemGrid } from "@/components/ItemGrid";
import { EmptyState } from "@/components/EmptyState";
import RefreshButton from "@/components/RefreshButton";
import { BUTTON_SMALL, PANEL_HEADER } from "@/components/stack";

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; category?: string }>;
}) {
  const { q, category } = await searchParams;

  let items: Item[] = [];
  let categories: string[] = [];
  let total = 0;
  let unreachable = false;

  try {
    const all = await listItems();
    total = all.length;
    categories = Array.from(new Set(all.map((i) => i.category).filter(Boolean))).sort();
    items = q?.trim() ? await searchItems(q) : await listItems(category);
  } catch {
    unreachable = true;
  }

  const activeQuery = q?.trim() ?? "";
  const dealt = activeQuery
    ? `Found: ${activeQuery}`
    : category
      ? `Deal: ${category}`
      : "The whole stack";

  return (
    <Shell cardCount={unreachable ? null : total}>
      <div className="space-y-5">
        <div className="hand bg-paper">
          <div className={PANEL_HEADER}>
            <span>{dealt}</span>
            <span className="tabular">
              {unreachable ? "—" : `${items.length} of ${total}`}
            </span>
          </div>

          <div className="space-y-3 px-3 py-3">
            <SearchBar defaultValue={activeQuery} category={category ?? ""} />

            {!unreachable && categories.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href="/"
                  aria-current={!category && !activeQuery ? "true" : undefined}
                  className={
                    !category && !activeQuery
                      ? "font-display hand bg-ink px-2.5 py-1 text-[12px] text-paper"
                      : BUTTON_SMALL
                  }
                >
                  All
                </Link>
                {categories.map((c) => {
                  const active = category === c && !activeQuery;
                  return (
                    <Link
                      key={c}
                      href={`/?category=${encodeURIComponent(c)}`}
                      aria-current={active ? "true" : undefined}
                      className={
                        active
                          ? "font-display hand bg-ink px-2.5 py-1 text-[12px] text-paper"
                          : BUTTON_SMALL
                      }
                    >
                      {c}
                    </Link>
                  );
                })}
                <span className="ml-auto">
                  {!unreachable ? <RefreshButton /> : null}
                </span>
              </div>
            ) : null}

            {activeQuery && !unreachable ? (
              <p className="text-[13px]">
                {items.length === 0
                  ? `No card matches “${activeQuery}”.`
                  : `${items.length} ${items.length === 1 ? "card" : "cards"} match “${activeQuery}”.`}{" "}
                <Link
                  href="/"
                  className="font-display underline decoration-2 underline-offset-2 hover:bg-ink hover:text-paper hover:no-underline"
                >
                  Deal the whole stack again
                </Link>
              </p>
            ) : null}
          </div>
        </div>

        {unreachable ? (
          <EmptyState
            title="The stack will not open"
            description={
              <>
                The local database could not be read. Reel Vault needs Node 24 or
                newer for its built-in <code>node:sqlite</code>. Check the server
                log, then load this card again.
              </>
            }
          />
        ) : (
          <div className="dissolve">
            <ItemGrid items={items} />
          </div>
        )}
      </div>
    </Shell>
  );
}
