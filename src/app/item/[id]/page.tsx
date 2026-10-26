import Link from "next/link";
import Shell from "@/components/Shell";
import ItemActions from "@/components/ItemActions";
import { EmptyState } from "@/components/EmptyState";
import { useParams } from "react-router";
import type { CardPosition, Item } from "@/lib/db";
import { useJson } from "@/lib/use-json";
import CardThumb from "@/components/CardThumb";
import ClipPlayer, { InstagramEmbed } from "@/components/ClipPlayer";
import CardNav from "@/components/CardNav";
import MarkCard from "@/components/MarkCard";
import { ArrowLeftIcon } from "@/components/icons";
import { BUTTON, PANEL, PANEL_HEADER } from "@/components/stack";

export default function ItemDetail() {
  const { id = "" } = useParams();
  const loaded = useJson<{ item: Item; position: CardPosition | null }>(`/api/card/${id}`);

  if (loaded.state === "loading") return <Shell>{null}</Shell>;
  if (loaded.state !== "ready") {
    return (
      <Shell>
        <EmptyState
          titleAs="h1"
          title="No such card"
          description="This card is not in the stack any more."
        >
          <Link href="/" className={BUTTON}>
            <ArrowLeftIcon />
            Back to the stack
          </Link>
        </EmptyState>
      </Shell>
    );
  }

  const { item, position } = loaded.data;
  const described = Boolean(item.summary && item.summary.trim());
  const fromDM = item.origin === "dm_shared";

  return (
    <Shell cardCount={position?.total ?? null}>
      <div className="dissolve mx-auto max-w-3xl space-y-4">
        <MarkCard id={item.id} title={item.title || "Untitled card"} />

        {position ? (
          <CardNav position={position} />
        ) : (
          <Link
            href="/"
            className="font-display inline-flex items-center gap-2 text-[13px] hover:bg-ink hover:text-paper"
          >
            <ArrowLeftIcon />
            Back to the stack
          </Link>
        )}

        <article className={PANEL}>
          <div className={PANEL_HEADER}>
            <span>{fromDM ? "Shared in a thread" : "Saved by you"}</span>
            {/* Ingest sometimes stores a raw numeric Instagram user id here.
                A bare id tells the reader nothing, so it is not shown. */}
            {item.author && !/^\d+$/.test(item.author) ? (
              <span>{item.author}</span>
            ) : null}
          </div>

          <div className="space-y-5 px-4 py-4">
            <h1 className="font-display text-[24px] leading-tight">
              {item.title || "Untitled card"}
            </h1>

            <div className="hand mx-auto aspect-[4/5] w-full max-w-sm overflow-hidden bg-paper">
              {item.clip ? (
                // The reel itself. Controls only: a vault does not autoplay at
                // you. The first play copies the file onto this machine, so
                // every play after this one is local.
                <ClipPlayer
                  src={item.clip}
                  poster={item.poster}
                  held={Boolean(item.video_file)}
                  embed={item.embed}
                />
              ) : item.embed ? (
                <InstagramEmbed src={item.embed} title={item.title || "Instagram reel"} />
              ) : (
                <CardThumb
                  src={item.poster}
                  alt={item.title || ""}
                  priority
                  expired={Boolean(item.thumbnail) && !item.poster}
                />
              )}
            </div>

            {described ? (
              <p className="max-w-[68ch] text-[14px] leading-relaxed">
                {item.summary}
              </p>
            ) : (
              // Absence, drawn. The vault does not pretend this card is described.
              <div className="hand stipple-1 px-4 py-4">
                <p className="font-display text-[12px] tracking-wide">
                  NOBODY HAS DESCRIBED THIS CARD
                </p>
                <p className="mt-1.5 max-w-[60ch] text-[13px] leading-relaxed">
                  It has a picture and a link, and nothing written about it, so
                  Find cannot match it on anything but its title.{" "}
                  <Link
                    href="/connect"
                    className="font-display underline decoration-2 underline-offset-2 hover:bg-ink hover:text-paper hover:no-underline"
                  >
                    Describe the blank cards
                  </Link>
                </p>
              </div>
            )}

            {item.tags.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {item.tags.map((tag) => (
                  <li
                    key={tag}
                    className="hand px-2 py-0.5 font-display text-[11px]"
                  >
                    {tag}
                  </li>
                ))}
              </ul>
            )}

            <div className="border-t-2 border-dotted border-ink pt-4">
              {/^https?:\/\//i.test(item.url) && (
                <a href={item.url} target="_blank" rel="noreferrer" className={BUTTON}>
                  Open the original
                </a>
              )}
            </div>
          </div>
        </article>

        <ItemActions id={item.id} initialNotes={item.notes ?? ""} />
      </div>
    </Shell>
  );
}
