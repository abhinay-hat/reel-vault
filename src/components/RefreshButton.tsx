"use client";

import { useState } from "react";
import { SyncIcon } from "@/components/icons";
import { BUTTON_SMALL } from "@/components/stack";

// A full reload: guarantees a fresh server render (re-reads the local DB and
// re-applies newest-first ordering). Simpler and more reliable than a soft RSC
// refresh, which shows no change when the data is unchanged.
export default function RefreshButton() {
  const [dealing, setDealing] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        setDealing(true);
        window.location.reload();
      }}
      disabled={dealing}
      className={BUTTON_SMALL}
    >
      <SyncIcon className="h-3.5 w-3.5" />
      {dealing ? "Re-dealing…" : "Re-deal"}
    </button>
  );
}
