"use client";

import { useEffect } from "react";
import { leaveMark } from "@/components/Trail";

/**
 * Opening a card leaves a mark on the stack. Rendered by the card page itself
 * so the mark records what was actually opened, not what was linked to.
 */
export default function MarkCard({ id, title }: { id: string; title: string }) {
  useEffect(() => {
    leaveMark({ href: `/item/${id}`, label: title });
  }, [id, title]);

  return null;
}
