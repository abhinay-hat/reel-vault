import type { Metadata, Viewport } from "next";
import { Pixelify_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";

// Chicago's role in the stack: menu bar, buttons, card titles, the wordmark.
// A pixel face, never anti-aliased into a "retro-flavoured" sans.
const pixel = Pixelify_Sans({
  variable: "--font-pixel",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

// Geneva's role: body, fields, records. Monospace here is not a costume for
// "technical" — it is the stack's own screen font, and the vault's records are
// columnar data that wants figures to line up.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Reel Vault",
  description: "A private shoebox of everything you saved.",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  colorScheme: "light",
};

const DIRECTION_CONTRACT = `<!--
THESIS: The hoard is a shoebox of cards you can read and write on, and a card
nobody has described looks blank. Refuses the search-bar-over-masonry-grid that
every saved-content app ships.
OWN-WORLD: 1-bit HyperCard. Black ink, white paper, a five-step Bayer stipple
ramp instead of grays, hand-drawn SVG borders, Chicago pixel chrome over Geneva
monospace records. No colour in the chrome; the reel thumbnail is pasted on at
full colour. The only state idiom is inversion to solid black.
STORY: The owner sees how much of the vault is actually described, finds one
half-remembered reel, and writes on the card that held it.
FIRST VIEWPORT: Menu bar, then a state line reading cards / described / sync age
with the undescribed remainder drawn as empty slots. Find field over the stack.
Below, the deal: hard-edged cards, described ones carrying a pasted photo,
undescribed ones showing their ruled, empty writing area.
FORM: HyperCard Shoebox Stack. Dealt challenger that beat assigned candidate 6
of 7 (Card Catalog) on both audience identification and product clarity.
Seed ffaa501a.
FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance.
-->`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${pixel.variable} ${geistMono.variable} h-full`}
    >
      <body className="min-h-full flex flex-col bg-paper text-ink">
        {/*
          The direction contract ships as a real HTML comment, not a JSX one:
          JSX comments are compiled away, and a contract the build erases is a
          contract nobody can audit.
        */}
        <div hidden dangerouslySetInnerHTML={{ __html: DIRECTION_CONTRACT }} />
        {children}
      </body>
    </html>
  );
}
