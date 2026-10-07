import Link from "next/link";
import Shell from "@/components/Shell";
import MessageThread from "@/components/MessageThread";
import { EmptyState } from "@/components/EmptyState";
import { useParams } from "react-router";
import type { Conversation, Message } from "@/lib/db";
import { useJson } from "@/lib/use-json";
import { ArrowLeftIcon } from "@/components/icons";
import { BUTTON } from "@/components/stack";

export default function ConversationPage() {
  const { id = "" } = useParams();
  const loaded = useJson<{ conversation: Conversation; messages: Message[] }>(
    `/api/conversations/${encodeURIComponent(id)}`,
  );

  if (loaded.state === "loading") return <Shell>{null}</Shell>;
  if (loaded.state !== "ready") {
    return (
      <Shell>
        <EmptyState
          titleAs="h1"
          title="No such thread"
          description="This thread is not in the stack, or it has not been brought in yet."
        >
          <Link href="/messages" className={BUTTON}>
            <ArrowLeftIcon />
            Back to threads
          </Link>
        </EmptyState>
      </Shell>
    );
  }

  return (
    <Shell>
      <MessageThread conversation={loaded.data.conversation} messages={loaded.data.messages} />
    </Shell>
  );
}
