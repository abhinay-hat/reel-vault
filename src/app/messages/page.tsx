import Link from "next/link";
import Shell from "@/components/Shell";
import ConversationList from "@/components/ConversationList";
import { EmptyState } from "@/components/EmptyState";
import type { Conversation } from "@/lib/db";
import { useJson } from "@/lib/use-json";
import { PANEL_HEADER } from "@/components/stack";

export default function MessagesPage() {
  const loaded = useJson<Conversation[]>("/api/conversations");
  const conversations: Conversation[] = loaded.state === "ready" ? loaded.data : [];
  const failed = loaded.state === "error";

  return (
    <Shell>
      <div className="dissolve space-y-4">
        <div className="hand bg-paper">
          <div className={PANEL_HEADER}>
            <span>Threads</span>
            <span className="tabular">
              {failed ? "—" : `${conversations.length}`}
            </span>
          </div>
          <p className="px-4 py-3 text-[13px] leading-relaxed">
            Most of this vault arrived here: reels traded in DMs, kept as cards
            alongside everything you saved on your own.
          </p>
        </div>

        {failed ? (
          <EmptyState
            title="Threads will not load"
            description="Something interrupted the read from your local database. Try again in a moment."
          />
        ) : conversations.length === 0 ? (
          <EmptyState
            title="No threads yet"
            description="Once you bring your shared reels in, the conversations live here."
          >
            <Link
              href="/connect"
              className="font-display hand inline-flex items-center bg-ink px-4 py-2 text-[14px] text-paper hover:bg-paper hover:text-ink"
            >
              Connect Instagram
            </Link>
          </EmptyState>
        ) : (
          <ConversationList conversations={conversations} />
        )}
      </div>
    </Shell>
  );
}
