import Link from "next/link";
import { useLocation } from "react-router";
import type { Item, VaultFacets, VaultFilter } from "@/lib/db";
import { useJson } from "@/lib/use-json";
import Shell from "@/components/Shell";
import SearchBar from "@/components/SearchBar";
import VaultFilters, { filterHref } from "@/components/VaultFilters";
import { ItemGrid } from "@/components/ItemGrid";
import { EmptyState } from "@/components/EmptyState";
import RefreshButton from "@/components/RefreshButton";
import { BUTTON_SMALL, PANEL_HEADER } from "@/components/stack";

type VaultPage = {
  filter: VaultFilter;
  facets: VaultFacets;
  total: number;
  matched: number;
  page: number;
  pages: number;
  items: Item[];
};

const EMPTY_FACETS: VaultFacets = { total: 0, categories: [], tags: [], kinds: [], months: null };

export default function Dashboard() {
  // The URL is the whole state; the server parses it, filters and pages (60 a page).
  const { search } = useLocation();
  const loaded = useJson<VaultPage>(`/api/vault${search}`);
  const data = loaded.state === "ready" ? loaded.data : null;
  const unreachable = loaded.state === "error";
  const f: VaultFilter = data?.filter ?? { sort: "new" };
  const { q, category } = f;
  const facets = data?.facets ?? EMPTY_FACETS;
  const total = data?.total ?? 0;
  const matchedCount = data?.matched ?? 0;
  const items: Item[] = data?.items ?? [];
  const pages = data?.pages ?? 1;
  const current = data?.page ?? 1;
  const pageHref = (n: number) => {
    const base = filterHref(f, { sort: f.sort === "old" ? "old" : "" });
    if (n <= 1) return base;
    return `${base}${base.includes("?") ? "&" : "?"}page=${n}`;
  };

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
    <Shell cardCount={unreachable || !data ? null : total}>
      <div className="space-y-5">
        <div className="hand bg-paper">
          <div className={PANEL_HEADER}>
            <span>{dealt}</span>
            <span className="tabular">
              {unreachable || !data ? "—" : `${matchedCount} of ${total}`}
            </span>
          </div>

          <div className="space-y-3 px-3 py-3">
            {/* Uncontrolled inputs: mount once the URL's filter is known. */}
            {data ? (
              <SearchBar key={search} defaultValue={activeQuery} keep={{ ...f, sort: f.sort === "old" ? "old" : undefined }} />
            ) : null}

            {data ? (
              <>
                <VaultFilters key={search} f={f} facets={facets} />
                <div className="flex justify-end">
                  <RefreshButton />
                </div>
              </>
            ) : null}

            {activeQuery && !unreachable ? (
              <p className="text-[13px]">
                {matchedCount === 0
                  ? `No card matches “${activeQuery}”.`
                  : `${matchedCount} ${matchedCount === 1 ? "card" : "cards"} match “${activeQuery}”.`}{" "}
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
            {pages > 1 ? (
              <nav aria-label="Pages" className="mt-5 flex items-center justify-center gap-3 text-[13px]">
                {current > 1 ? <Link href={pageHref(current - 1)} className={BUTTON_SMALL}>← Previous</Link> : null}
                <span className="tabular">{`Page ${current} of ${pages}`}</span>
                {current < pages ? <Link href={pageHref(current + 1)} className={BUTTON_SMALL}>Next →</Link> : null}
              </nav>
            ) : null}
          </div>
        )}
      </div>
    </Shell>
  );
}
