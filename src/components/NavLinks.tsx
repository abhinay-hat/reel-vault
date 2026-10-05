"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { StackIcon, CardIcon, FindIcon, SyncIcon } from "@/components/icons";

// The stack's sections are cards in a numbered stack, not tabs. The rail is the
// HyperCard "stack contents" list; the menu bar is the same set collapsed to a
// single row for narrow screens. Selected in both cases means inverted to solid
// black, which is the stack's only selection idiom.

const cards = [
  { href: "/", label: "Vault", Icon: StackIcon },
  { href: "/messages", label: "Threads", Icon: CardIcon },
  { href: "/chat", label: "Find", Icon: FindIcon },
  { href: "/connect", label: "Sync", Icon: SyncIcon },
] as const;

function useActive() {
  const pathname = usePathname();
  return (href: string) =>
    href === "/"
      ? pathname === "/" || pathname.startsWith("/item")
      : pathname.startsWith(href);
}

/** Narrow screens: the section list collapsed into the menu bar. */
export function MenuBar() {
  const isActive = useActive();

  return (
    <nav aria-label="Primary" className="lg:hidden">
      <ul className="flex items-center">
        {cards.map(({ href, label }) => {
          const active = isActive(href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`font-display block px-3 py-1 text-[15px] ${
                  active ? "bg-ink text-paper" : "text-ink hover:bg-ink hover:text-paper"
                }`}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Wide screens: the stack contents rail, numbered the way a stack is. */
export function StackContents({ count }: { count: number | null }) {
  const isActive = useActive();

  return (
    <nav aria-label="Primary" className="hidden lg:block">
      <div className="hand bg-paper">
        <div className="flex items-baseline justify-between border-b-2 border-ink px-3 py-2">
          <h2 className="font-display text-[13px] tracking-wide">STACK CONTENTS</h2>
          <p className="tabular text-[11px]">
            {count === null ? "—" : `${count} cards`}
          </p>
        </div>
        <ul>
          {cards.map(({ href, label, Icon }, i) => {
            const active = isActive(href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-3 px-3 py-2 text-[14px] ${
                    active
                      ? "bg-ink text-paper"
                      : "text-ink hover:bg-ink hover:text-paper"
                  }`}
                >
                  <Icon />
                  <span className="font-display flex-1">{label}</span>
                  <span className="tabular text-[12px]">{i + 1}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
