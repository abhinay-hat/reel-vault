import Link from "next/link";
import type { Conversation } from "@/lib/db";
import RelativeTime from "@/components/RelativeTime";
import { CardIcon } from "@/components/icons";

/**
 * Threads as a numbered stack list, matching the contents rail: the row is the
 * card, and the whole row inverts on hover the way a stack selection does.
 */
export default function ConversationList({
  conversations,
}: {
  conversations: Conversation[];
}) {
  return (
    <ul className="hand divide-y-2 divide-ink bg-paper">
      {conversations.map((c, i) => (
        <li key={c.id}>
          <Link
            href={`/messages/${c.id}`}
            className="group flex items-center gap-3 px-3 py-3 hover:bg-ink hover:text-paper"
          >
            <CardIcon />
            <div className="min-w-0 flex-1">
              <p className="font-display truncate text-[14px]">{c.title}</p>
              {c.participants.length > 0 && (
                <p className="mt-0.5 truncate text-[12px]">
                  {c.participants.join(", ")}
                </p>
              )}
            </div>
            <RelativeTime
              iso={c.last_message_at}
              fallback="No messages yet"
              className="tabular shrink-0 text-[11px]"
            />
            <span className="tabular shrink-0 text-[11px]">{i + 1}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
