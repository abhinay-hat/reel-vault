# Reel Vault — Design System

Register: **product** (design serves retrieval). Mode: **Operate** — the visitor
completes a task, so scanability and state legibility outrank expression.

**Committed world: a 1-bit HyperCard shoebox stack.** Black ink on white paper,
a five-step ordered-dither ramp instead of grays, hand-drawn SVG borders, pixel
chrome over monospace records. The one exception is the reel thumbnail, which is
pasted onto its card at full colour the way a photograph is pasted into a stack.

Seed `ffaa501a`. Chosen as the dealt challenger that beat the assigned direction
(Card Catalog) on both audience identification and product clarity. It replaced a
warm-cream / display-serif / terracotta system that was, verbatim, the most
common machine-generated interface look.

## The thesis this world exists to serve

The vault holds 198 cards and **0 of them are described**; 53% have no usable
title and every thumbnail URL has expired. The previous design presented that
vault as though it were complete. This world draws absence as deliberately as
presence, so the state of the archive is the first thing the page says.

## Color

There are two colours and one ramp. No accent, no danger hue, no tint.

```css
:root {
  --ink:   #000000;
  --paper: #ffffff;
}
```

Every value between them is an **ordered 4×4 Bayer dither**, not opacity: real
hard-edged pixels that stay crisp at any zoom, which is what makes the surface
read as 1-bit rather than as gray paint.

| Class | Coverage | Used for |
|---|---|---|
| `.stipple-1` | 12% | Empty ledger slots, notices, undescribed panels |
| `.stipple-2` | 25% | Expired/absent picture fields |
| `.stipple-3` | 50% | The working indicator |
| `.stipple-4` | 75% | Reserved |
| `.stipple-5` | 90% | The footer's dark closing band |

Tailwind v4 maps `--color-ink` / `--color-paper`, so `bg-ink`, `text-paper`,
`border-ink` work. Stipple classes are plain CSS, applied directly.

**State is expressed by inversion only.** A control at rest is ink on paper in a
hand-drawn frame; hovered, active, or primary, it fills solid black with paper
text. There is no fill tint, no shadow, and no third state colour.

## Typography

- **Chicago's role** — `.font-display` (Pixelify Sans): menu bar, buttons, card
  titles, wordmark, all small-caps labels. Chicago itself is not web-obtainable;
  Pixelify is the closest genuine bitmap face. Never used for body copy.
- **Geneva's role** — `--font-sans` (Geist Mono): body, fields, records. The
  monospace is not a costume for "technical"; the vault's records are columnar
  data and the figures must line up.
- Scale: card title `13px`, body `13–14px`, page title `20–24px`, meta `10–12px`.
  Small and dense on purpose; a stack shows many cards at once.
- `-webkit-font-smoothing: none` so pixel type stays pixel type.
- Body measure capped ~68ch. `.tabular` for any column of figures.

## Materials

- **Hand-drawn borders** (`.hand`, `.hand-thick`): a wobbling stroke rendered as
  a real SVG `border-image`, not a rounded-corner approximation. These frames
  were drawn with a mouse in 1987 and a geometrically perfect rectangle is the
  wrong shape.
- **No shadow anywhere.** Elevation is hairline seams (2px rules) and inversion.
- **No rounded corners, no gradient, no glass.**

## Layout

- Menu bar across the top, **state line** directly under it, contents rail down
  the left at `lg`, the open card in the middle, dark band at the foot.
- The state line always reads `N CARDS · N DESCRIBED · SYNCED N DAYS AGO` with a
  slot-strip ledger: filled for each described card, an empty ruled slot for each
  one nobody has written on. This is not optional chrome; it is the thesis.
- Grid: `grid-cols-2 sm:3 lg:4`, `gap-3`. Cards below the fold use
  `content-visibility: auto` with a reserved intrinsic size.
- Page gutter `px-4`, section rhythm `space-y-4`/`space-y-5`.

## Components

- `Shell` — menu bar, `StackState`, contents rail, `main#card`, footer + `Trail`.
- `StackState` — the vault's condition, on every screen.
- `ItemCard` — provenance tag (`DM` inverted / `SAVED` outline), stack number,
  pasted photo, then either title + summary or **BLANK** over ruled empty lines.
- `CardThumb` — client component; a picture that 403s renders as a stipple field
  labelled PICTURE EXPIRED. Checks `naturalWidth` on mount, because a
  server-rendered image fails before React can attach `onError`.
- `CardNav` — `← ≡ N of M ⊞ →`. A stack always says where in it you are.
- `Trail` — marks persist: cards you opened stay listed in the footer.
- `EmptyState` — one treatment for empty, not-found, and failed states.
- `stack.ts` — `BUTTON`, `BUTTON_PRIMARY`, `BUTTON_DANGER`, `BUTTON_SMALL`,
  `FIELD`, `PANEL`, `PANEL_HEADER`, `RULE`. All controls come from here.
- `icons.tsx` — authored SVG on a 16×16 pixel grid, `shapeRendering="crispEdges"`.
  Never emoji, never a third-party stroke set.

## Motion

One authored moment: `.dissolve`, a `steps(5)` dither dissolve on card entry,
the way a HyperCard visual effect resolved one pixel pattern into another. Not
scattered across hovers. Fully disabled under `prefers-reduced-motion`.

## Browser surfaces

Selection, caret, focus ring, and scrollbar are all themed to ink/paper. The
scrollbar track is stippled with a 2px ink rule. These are where a 1-bit world
would otherwise leak.

## Bans (enforced)

No colour in chrome. No shadow, gradient, glass, or rounded corner. No anti-
aliased display type. No emoji or Unicode glyph standing in for an icon. No
kicker or eyebrow above a heading. No hero-metric template. No filler text where
a record is empty — an undescribed card shows its ruled writing area instead.

## Known open at time of writing

- Border wobble reads near-straight at 1× and is under-committed against the
  quality bar.
- The pasted-photo promise is unmet in real data: every Instagram thumbnail URL
  has expired, so the colour exception never actually appears. Fixing that is a
  re-sync, not a style change.
