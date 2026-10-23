"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { StackIcon } from "@/components/icons";
import { BUTTON_PRIMARY, FIELD, PANEL, PANEL_HEADER } from "@/components/stack";

export default function LoginPage() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Kept enabled while empty: a disabled submit gives no feedback about *why*
  // it will not go, so validate on press and send focus back to the field.
  function fail(message: string) {
    setError(message);
    field.current?.focus();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (checking) return;
    if (!passcode) {
      fail("Enter your passcode to open the stack.");
      return;
    }
    setChecking(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      if (res.ok) {
        router.push("/");
        return;
      }
      fail("That passcode does not match. Check it and try again.");
    } catch {
      fail("Could not reach the stack. Check that the app is running, then try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-4">
      <form onSubmit={submit} className={`${PANEL} dissolve w-full max-w-sm`}>
        <div className={PANEL_HEADER}>
          <span className="flex items-center gap-2">
            <StackIcon className="h-3.5 w-3.5" />
            Reel Vault
          </span>
          <span>LOCKED</span>
        </div>

        <div className="space-y-4 px-4 py-6">
          <div className="space-y-1.5">
            <h1 className="font-display text-[18px] leading-tight">
              This stack is closed
            </h1>
            <p className="text-[13px] leading-relaxed">
              One passcode, one person. Everything inside stays on this machine.
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="passcode" className="font-display block text-[12px] tracking-wide">
              PASSCODE
            </label>
            <input
              id="passcode"
              ref={field}
              name="passcode"
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              autoComplete="current-password"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "passcode-error" : undefined}
              className={FIELD}
            />
            {error ? (
              <p
                id="passcode-error"
                role="alert"
                className="hand stipple-1 px-2.5 py-1.5 text-[12px]"
              >
                {error}
              </p>
            ) : null}
          </div>

          <button type="submit" disabled={checking} className={`${BUTTON_PRIMARY} w-full`}>
            {checking ? "Opening…" : "Open the Stack"}
          </button>
        </div>
      </form>
    </main>
  );
}
