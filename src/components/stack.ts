/**
 * The stack's control vocabulary, in one place so every button, field, and
 * panel across the app is the same object.
 *
 * There is exactly one state idiom: inversion. A control at rest is ink on
 * paper inside a hand-drawn frame; pressed, active, or primary, it is filled
 * solid black with paper text. No shadow, no fill tint, no accent colour.
 */

export const BUTTON =
  "font-display hand inline-flex items-center justify-center gap-2 bg-paper px-4 py-2 text-[14px] text-ink transition-none hover:bg-ink hover:text-paper active:bg-ink active:text-paper disabled:opacity-40 disabled:hover:bg-paper disabled:hover:text-ink";

/** The one action the card is for. Filled by default, inverting on press. */
export const BUTTON_PRIMARY =
  "font-display hand inline-flex items-center justify-center gap-2 bg-ink px-4 py-2 text-[14px] text-paper hover:bg-paper hover:text-ink active:bg-paper active:text-ink disabled:opacity-40 disabled:hover:bg-ink disabled:hover:text-paper";

/** Destructive actions live alone, never adjacent to a confirming control. */
export const BUTTON_DANGER =
  "font-display hand inline-flex items-center justify-center gap-2 bg-paper px-4 py-2 text-[14px] text-ink underline decoration-2 underline-offset-2 hover:bg-ink hover:text-paper hover:no-underline disabled:opacity-40";

export const BUTTON_SMALL =
  "font-display hand inline-flex items-center justify-center gap-1.5 bg-paper px-2.5 py-1 text-[12px] text-ink hover:bg-ink hover:text-paper disabled:opacity-40 disabled:hover:bg-paper disabled:hover:text-ink";

export const FIELD =
  "hand w-full bg-paper px-3 py-2 text-[14px] text-ink placeholder:text-ink placeholder:opacity-45 focus:outline-none";

export const PANEL = "hand bg-paper";

/** A filled title bar, the way a HyperCard card announces itself. */
export const PANEL_HEADER =
  "font-display flex items-center justify-between gap-3 bg-ink px-3 py-1.5 text-[12px] tracking-wide text-paper";

/** A quiet section label: small caps over a dotted rule, never a kicker. */
export const RULE = "border-b-2 border-dotted border-ink";
