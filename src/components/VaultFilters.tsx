import Link from "next/link";
import type { VaultFacets, VaultFilter } from "@/lib/db";
import { BUTTON_PRIMARY, BUTTON_SMALL, FIELD } from "@/components/stack";

const KIND_LABEL: Record<string, string> = {
  ai_model: "AI model",
  job_portal: "Job portal",
};
const label = (k: string) => KIND_LABEL[k] ?? k.charAt(0).toUpperCase() + k.slice(1);

const STATUS_LABEL: [string, string][] = [
  ["described", "Summarised"],
  ["undescribed", "Not summarised yet"],
  ["spoken", "Has speech"],
  ["onscreen", "Has on-screen text"],
  ["unavailable", "Unavailable"],
];

/** Current filters as a query string, with `patch` applied (empty value removes the key). */
export function filterHref(f: VaultFilter, patch: Partial<Record<keyof VaultFilter, string>>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...patch })) if (v) p.set(k, String(v));
  const s = p.toString();
  return s ? `/?${s}` : "/";
}

/**
 * Every filter is a plain GET form field, so the URL is the whole state: it can
 * be bookmarked, and back/forward just works. Native controls only.
 */
export default function VaultFilters({ f, facets }: { f: VaultFilter; facets: VaultFacets }) {
  const [minMonth, maxMonth] = facets.months ?? ["", ""];
  const active = Boolean(f.category || f.tag || f.kind || f.from || f.to || f.status || f.sort === "old");

  return (
    <div className="space-y-3">
      <form action="/" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {f.q ? <input type="hidden" name="q" value={f.q} /> : null}
        {f.tag ? <input type="hidden" name="tag" value={f.tag} /> : null}

        <label className="space-y-1 text-[12px] uppercase tracking-wide">
          <span>Category</span>
          <select name="category" defaultValue={f.category ?? ""} className={FIELD}>
            <option value="">All</option>
            {facets.categories.map(([c, n]) => (
              <option key={c} value={c}>{`${c} (${n})`}</option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-[12px] uppercase tracking-wide">
          <span>Mentions</span>
          <select name="kind" defaultValue={f.kind ?? ""} className={FIELD}>
            <option value="">Anything</option>
            {facets.kinds.map(([k, n]) => (
              <option key={k} value={k}>{`${label(k)} (${n})`}</option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-[12px] uppercase tracking-wide">
          <span>Status</span>
          <select name="status" defaultValue={f.status ?? ""} className={FIELD}>
            <option value="">Any</option>
            {STATUS_LABEL.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-[12px] uppercase tracking-wide">
          <span>Order</span>
          <select name="sort" defaultValue={f.sort ?? "new"} className={FIELD}>
            <option value="new">Newest first</option>
            <option value="old">Oldest first</option>
          </select>
        </label>

        <label className="space-y-1 text-[12px] uppercase tracking-wide">
          <span>From</span>
          <input type="month" name="from" defaultValue={f.from ?? ""} min={minMonth} max={maxMonth} className={FIELD} />
        </label>

        <label className="space-y-1 text-[12px] uppercase tracking-wide">
          <span>To</span>
          <input type="month" name="to" defaultValue={f.to ?? ""} min={minMonth} max={maxMonth} className={FIELD} />
        </label>

        <div className="col-span-2 flex items-end gap-2">
          <button type="submit" className={BUTTON_PRIMARY}>Apply</button>
          {active ? (
            <Link href={f.q ? filterHref({ q: f.q }, {}) : "/"} className={BUTTON_SMALL}>
              Clear filters
            </Link>
          ) : null}
        </div>
      </form>

      {facets.tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Top tags">
          <span className="text-[12px] uppercase tracking-wide">Tags</span>
          {facets.tags.map(([t, n]) => {
            const on = f.tag === t;
            return (
              <Link
                key={t}
                href={filterHref(f, { tag: on ? "" : t })}
                aria-current={on ? "true" : undefined}
                className={on ? "font-display hand bg-ink px-2 py-0.5 text-[12px] text-paper" : BUTTON_SMALL}
              >
                {`${t} ${n}`}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
