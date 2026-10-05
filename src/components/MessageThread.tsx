import type { Conversation, Message } from "@/lib/db";
import { PANEL, PANEL_HEADER } from "@/components/stack";

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A reel traded in the thread, pasted onto the message as its own small card. */
function SharedCard({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label={`Shared reel on ${hostOf(url)} (opens in a new tab)`}
      className="hand mt-2 flex items-center gap-2.5 bg-paper px-2.5 py-1.5 hover:bg-ink hover:text-paper"
    >
      <svg
        viewBox="0 0 16 16"
        className="h-4 w-4 shrink-0"
        fill="currentColor"
        shapeRendering="crispEdges"
        aria-hidden
      >
        <path d="M4 2h2v12H4zM6 4h2v8H6zM8 6h2v4H8zM10 7h2v2h-2z" />
      </svg>
      <span className="min-w-0">
        <span className="font-display block truncate text-[12px]">
          Shared reel
        </span>
        <span className="block truncate text-[11px]">{hostOf(url)}</span>
      </span>
    </a>
  );
}

export default function MessageThread({
  conversation,
  messages,
}: {
  conversation: Conversation;
  messages: Message[];
}) {
  // TODO: identify "me" reliably. `m.sender` is a raw Instagram numeric
  // user_id while `conversation.participants` are usernames, so the two never
  // match and we cannot tell whose bubble is whose. Rather than render a bare
  // numeric id above every message (which looks broken) or invent a fake
  // identity, we show one uniform, readable column. Once the ingest maps
  // sender ids to usernames, restore the two-sided "mine" layout below.

  return (
    <div className="dissolve mx-auto max-w-3xl space-y-4">
      <div className={PANEL}>
        <div className={PANEL_HEADER}>
          <span>Thread</span>
          <span className="tabular">{messages.length} messages</span>
        </div>
        <div className="px-4 py-3">
          <h1 className="font-display text-[20px] leading-tight">
            {conversation.title}
          </h1>
          {conversation.participants.length > 0 && (
            <p className="mt-1 text-[13px]">
              {conversation.participants.join(", ")}
            </p>
          )}
        </div>
      </div>

      {messages.length === 0 ? (
        <p className="text-[13px]">No messages on this card.</p>
      ) : (
        <ol className="space-y-3">
          {messages.map((m) => (
            <li key={m.id} className="hand bg-paper px-3 py-2">
              {m.content && (
                <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">
                  {m.content}
                </p>
              )}
              {m.shared_url && <SharedCard url={m.shared_url} />}
              <time
                dateTime={m.sent_at}
                className="tabular mt-1.5 block text-[11px]"
              >
                {timeLabel(m.sent_at)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
