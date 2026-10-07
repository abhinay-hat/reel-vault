import { FindIcon } from "@/components/icons";
import { BUTTON_PRIMARY } from "@/components/stack";

/**
 * Find. One control restructures the whole field: submitting re-deals the
 * entire stack rather than filtering a list in place, so the result is always
 * "here is the stack, dealt again" and never a half-filtered view.
 */
export default function SearchBar({
  defaultValue = "",
  keep = {},
  placeholder = "Type what it was about…",
}: {
  defaultValue?: string;
  /** Active filters, kept as hidden fields so finding does not silently drop them. */
  keep?: Record<string, string | undefined>;
  placeholder?: string;
}) {
  return (
    <form action="/" role="search" className="w-full">
      <label htmlFor="vault-find" className="sr-only">
        Find a card
      </label>
      {Object.entries(keep).map(([k, v]) =>
        v && k !== "q" ? <input key={k} type="hidden" name={k} value={v} /> : null,
      )}

      <div className="hand flex items-stretch bg-paper focus-within:outline-3 focus-within:outline-offset-2 focus-within:outline-ink">
        <span className="flex items-center border-r-2 border-ink px-2.5">
          <FindIcon />
        </span>
        <input
          id="vault-find"
          type="search"
          name="q"
          defaultValue={defaultValue}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="w-full bg-paper px-3 py-2 text-[14px] text-ink placeholder:text-ink placeholder:opacity-45 focus:outline-none"
        />
        <button type="submit" className={`${BUTTON_PRIMARY} border-0 border-l-2 border-solid border-ink`}>
          Find
        </button>
      </div>
    </form>
  );
}
