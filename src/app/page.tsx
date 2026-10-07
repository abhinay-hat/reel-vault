import Link from "next/link";
import { filterItems, vaultFacets, type Item, type VaultFacets, type VaultFilter, type VaultStatus } from "@/lib/db";
import Shell from "@/components/Shell";
import SearchBar from "@/components/SearchBar";
import VaultFilters from "@/components/VaultFilters";
import { ItemGrid } from "@/components/ItemGrid";
import { EmptyState } from "@/components/EmptyState";
import RefreshButton from "@/components/RefreshButton";
import { PANEL_HEADER } from "@/components/stack";

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const ym = (v?: string) => (v && /^\d{4}-\d{2}$/.test(v) ? v : undefined);
  const f: VaultFilter = {
    q: sp.q?.trim() || undefined,
    category: sp.category || undefined,
    tag: sp.tag || undefined,
    kind: sp.kind || undefined,
    from: ym(sp.from),
    to: ym(sp.to),
    status: (sp.status as VaultStatus) || undefined,
    sort: sp.sort === "old" ? "old" : "new",
  };
  const { q, category } = f;

  let items: Item[] = [];
  let facets: VaultFacets = { total: 0, categories: [], tags: [], kinds: [], months: null };
  let total = 0;
  let unreachable = false;

  try {
    facets = await vaultFacets();
    total = facets.total;
    items = await filterItems(f);
  } catch {
    unreachable = true;
  }

  const activeQuery = q?.trim() ?? "";
  const filtered = Boolean(category || f.tag || f.kind || f.from || f.to || f.status);
  const dealt = activeQuery
    ? `Found: ${activeQuery}`
    : filtered
      ? `Deal: ${[category, f.tag && `#${f.tag}`, f.kind, f.from || f.to ? `${f.from ?? "…"} → ${f.to ?? "…"}` : null, f.status]
          .filter(Boolean)
          .join(" · ")}`
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
            <SearchBar defaultValue={activeQuery} keep={{ ...f, sort: f.sort === "old" ? "old" : undefined }} />

            {!unreachable ? (
              <>
                <VaultFilters f={f} facets={facets} />
                <div className="flex justify-end">
                  <RefreshButton />
                </div>
              </>
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
