"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveNotes, deleteItem } from "@/app/actions";
import { PaintIcon } from "@/components/icons";
import {
  BUTTON,
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  PANEL,
  PANEL_HEADER,
} from "@/components/stack";

/**
 * The card's writing area. In this stack reading and writing are one mode, so
 * the note is not a secondary panel below the content — it is the ruled space
 * on the card itself, and it is always open.
 *
 * Delete sits alone at the foot with nothing beside it, and takes two
 * deliberate presses. There is no undo store behind it.
 */
export default function ItemActions({
  id,
  initialNotes,
}: {
  id: string;
  initialNotes: string;
}) {
  const router = useRouter();
  const [notes, setNotes] = useState(initialNotes);
  const [savedNotes, setSavedNotes] = useState(initialNotes);
  const [saved, setSaved] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isSaving, startSave] = useTransition();
  const [isDeleting, startDelete] = useTransition();

  const dirty = notes !== savedNotes;

  // Writing on a card is real work; a stray back-swipe should not eat it.
  useEffect(() => {
    if (!dirty || isDeleting) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, isDeleting]);

  function onSave() {
    setSaved(false);
    const pending = notes;
    startSave(async () => {
      await saveNotes(id, pending);
      setSavedNotes(pending);
      setSaved(true);
    });
  }

  function onDelete() {
    startDelete(async () => {
      await deleteItem(id);
      router.push("/");
    });
  }

  return (
    <section className="space-y-4">
      <div className={PANEL}>
        <div className={PANEL_HEADER}>
          <span className="flex items-center gap-2">
            <PaintIcon className="h-3.5 w-3.5" />
            Your hand
          </span>
          <span aria-live="polite">
            {isSaving ? "Writing…" : saved && !dirty ? "Written" : ""}
          </span>
        </div>

        <div className="space-y-3 px-3 py-3">
          <label htmlFor="item-notes" className="sr-only">
            Write on this card
          </label>
          <textarea
            id="item-notes"
            rows={4}
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              setSaved(false);
            }}
            placeholder="Write on this card…"
            className="hand w-full resize-y bg-paper px-3 py-2 text-[14px] leading-relaxed text-ink placeholder:text-ink placeholder:opacity-45 focus:outline-none"
          />
          <button
            type="button"
            onClick={onSave}
            disabled={isSaving || !dirty}
            className={BUTTON_PRIMARY}
          >
            {isSaving ? "Writing…" : "Write"}
          </button>
        </div>
      </div>

      {/* Isolated: nothing that confirms sits next to the thing that destroys. */}
      <div className="border-t-2 border-dotted border-ink pt-4">
        {confirmingDelete ? (
          <div className="space-y-3">
            <p role="alert" className="text-[13px]">
              Tear this card out of the stack? It does not come back.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={onDelete}
                disabled={isDeleting}
                className={BUTTON_PRIMARY}
              >
                {isDeleting ? "Tearing out…" : "Tear It Out"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={isDeleting}
                className={BUTTON}
              >
                Keep It
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            className={BUTTON_DANGER}
          >
            Tear out of stack
          </button>
        )}
      </div>
    </section>
  );
}
