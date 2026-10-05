import Link from "next/link";
import Shell from "@/components/Shell";
import MessageThread from "@/components/MessageThread";
import { EmptyState } from "@/components/EmptyState";
import { getConversation, type Conversation } from "@/lib/db";
import { ArrowLeftIcon } from "@/components/icons";
import { BUTTON } from "@/components/stack";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let conversation: Conversation | null = null;
  let messages: Awaited<ReturnType<typeof getConversation>>["messages"] = [];
  let failed = false;

  try {
    const result = await getConversation(id);
    conversation = result.conversation;
    messages = result.messages;
  } catch {
    failed = true;
  }

  if (failed || !conversation) {
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
      <MessageThread conversation={conversation} messages={messages} />
    </Shell>
  );
}
