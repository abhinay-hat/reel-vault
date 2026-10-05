"use client";

// The account sync dashboard. The account is connected once and the helper
// keeps the session; this page is about *syncing*, so credentials live in a
// secondary "Account session" section and never gate the primary action.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Shell } from "@/components/Shell";
import RelativeTime from "@/components/RelativeTime";
import {
  BUTTON,
  BUTTON_PRIMARY,
  BUTTON_SMALL,
  FIELD,
  PANEL,
  PANEL_HEADER,
} from "@/components/stack";

type Account = { logged_in?: boolean; username?: string; full_name?: string };
type Phase = "idle" | "connecting" | "syncing";

// Local helper state, straight from the sidecar's /health.
type Helper = {
  state: "running" | "offline" | "auth_required" | "session_expired" | "cooling_down" | "checking";
  username?: string | null;
  cooldownReason?: string | null;
  sessionRetryInS?: number;
  lastGatherAt?: string | null;
  nextGatherInS?: number;
  minIntervalHours?: number;
};

type SyncRun = {
  id: string;
  started_at: string;
  finished_at: string;
  status: "done" | "error";
  items: number;
  conversations: number;
  messages: number;
  skipped: number;
  error: string | null;
};

type Person = { id: string; label: string };
type ThreadInfo = {
  thread_id?: string;
  title?: string;
  users?: string[];
  users_detail?: { id?: string; username?: string }[];
};

// Everything is pulled by default. The scope controls below let the owner
// narrow a sync to a date range and to specific people, to stay quiet.
const ALL_TYPES = ["saved", "reels", "dms", "articles"];

// What the sidecar actually gathers, in the order it gathers it.
const SYNCED = [
  ["Saved posts", "Posts you saved on Instagram, from every collection."],
  ["Saved reels", "Reels you saved, with their thumbnails and video."],
  ["DM reel shares", "Reels and posts shared into your direct messages."],
  ["Links & articles", "Links sent in DMs, saved as readable articles."],
] as const;

// The sidecar's own progress strings, mapped to the stages a person cares
// about.
const STAGES: [string, string][] = [
  ["starting", "Preparing sync"],
  ["reading saved collections", "Fetching saved posts and reels"],
  ["reading direct messages", "Reading DM shares and links"],
  ["complete", "Updating Reel Vault"],
];

function daysAgoISO(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function hoursLabel(seconds: number): string {
  if (seconds <= 0) return "now";
  const h = Math.floor(seconds / 3600);
  if (h >= 1) return `in about ${h}h`;
  return `in about ${Math.max(1, Math.round(seconds / 60))} min`;
}

export default function ConnectPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [helper, setHelper] = useState<Helper>({ state: "checking" });
  const [runs, setRuns] = useState<SyncRun[]>([]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [err, setErr] = useState("");
  const [needsReauth, setNeedsReauth] = useState(false);
  // Which action failed. A sign-in failure must not be reported as a failed
  // sync, and its retry has to re-run the sign-in, not the sync.
  const [errSource, setErrSource] = useState<"sync" | "auth">("sync");
  const [progress, setProgress] = useState("");
  const [found, setFound] = useState(0);
  const [result, setResult] = useState<
    { items: number; conversations: number; messages: number; skipped: number; partial: boolean } | null
  >(null);

  // Secondary auth section.
  const [authOpen, setAuthOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needs2fa, setNeeds2fa] = useState(false);
  const [sessionid, setSessionid] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  // AI enrichment of newly-synced items. Runs the markitdown-backed worker;
  // this is the only in-app trigger for it.
  const [enriching, setEnriching] = useState(false);
  const [enriched, setEnriched] = useState<number | null>(null);
  const [enrichErr, setEnrichErr] = useState("");

  // Sync scope. Empty selection + empty dates = pull everything.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [threadIds, setThreadIds] = useState<Record<string, string | undefined>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Pulling media onto this machine. Separate from sync because it also has to
  // run over items already in the vault, whose pictures were never downloaded.
  const [repairing, setRepairing] = useState(false);
  const [repairResult, setRepairResult] = useState("");

  async function repairMedia() {
    setRepairing(true);
    setRepairResult("");
    try {
      const res = await fetch("/api/media/repair", { method: "POST" });
      const d = await res.json();
      if (!res.ok) {
        setRepairResult("Could not pull the media in.");
        return;
      }
      setRepairResult(
        `Held ${d.cached} on this machine. ${d.expired} have expired links and need a fresh sync. ${d.skipped} were already local.`,
      );
    } catch {
      setRepairResult("Could not reach the vault.");
    } finally {
      setRepairing(false);
    }
  }

  const busy = phase === "connecting" || phase === "syncing";
  const connected = Boolean(account?.logged_in);
  const scoped = selectedIds.size > 0 || Boolean(dateFrom) || Boolean(dateTo);
  const lastRun = runs[0] ?? null;

  // Turn an /api/ig/info payload into the people checklist. Defensive: the
  // double-nested threads and the users_detail field may both be absent
  // depending on the bridge version, so degrade to usernames or the title.
  function ingestInfo(info: unknown) {
    const threads = (info as { threads?: { threads?: ThreadInfo[] } } | undefined)?.threads?.threads;
    if (!Array.isArray(threads)) return;

    const byId = new Map<string, Person>();
    const tids: Record<string, string | undefined> = {};

    for (const t of threads) {
      const detail = Array.isArray(t.users_detail) ? t.users_detail : [];
      if (detail.length > 0) {
        for (const u of detail) {
          if (!u?.id) continue;
          const label = u.username ? `@${u.username}` : `User ${u.id}`;
          if (!byId.has(u.id)) byId.set(u.id, { id: u.id, label });
          tids[u.id] = t.thread_id;
        }
      } else if (Array.isArray(t.users) && t.users.length > 0) {
        for (const name of t.users) {
          if (!name) continue;
          if (!byId.has(name)) byId.set(name, { id: name, label: `@${name}` });
          tids[name] = t.thread_id;
        }
      } else if (t.title && t.thread_id) {
        if (!byId.has(t.thread_id)) byId.set(t.thread_id, { id: t.thread_id, label: t.title });
        tids[t.thread_id] = t.thread_id;
      }
    }

    setPeople(Array.from(byId.values()).sort((a, b) => a.label.localeCompare(b.label)));
    setThreadIds(tids);
  }

  const loadHelper = useCallback(async () => {
    try {
      const res = await fetch("/api/ig/health");
      const h = await res.json();
      if (!res.ok || h?.error) {
        setHelper({ state: "offline" });
        return;
      }
      setHelper({
        // "expired" is the case worth naming: a session was linked and
        // Instagram later refused it, which reads very differently from
        // never having connected at all.
        state: h.cooling_down
          ? "cooling_down"
          : h.logged_in
            ? "running"
            : h.session_status === "expired"
              ? "session_expired"
              : "auth_required",
        username: h.username,
        cooldownReason: h.cooldown_reason,
        sessionRetryInS: h.session_retry_in_s ?? 0,
        lastGatherAt: h.last_gather_at ?? null,
        nextGatherInS: h.next_gather_in_s ?? 0,
        minIntervalHours: h.min_interval_hours,
      });
    } catch {
      setHelper({ state: "offline" });
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const j = await (await fetch("/api/sync-runs")).json();
      if (Array.isArray(j.runs)) setRuns(j.runs);
    } catch {
      /* history is supporting detail; a failure here must not break the page */
    }
  }, []);

  const loadAccount = useCallback(async () => {
    try {
      const info = await (await fetch("/api/ig/info")).json();
      if (info.account?.logged_in) {
        setAccount(info.account);
        setNeedsReauth(false);
        ingestInfo(info);
      } else {
        setAccount(null);
      }
    } catch {
      setAccount(null);
    }
  }, []);

  useEffect(() => {
    void loadHelper();
    void loadRuns();
    void loadAccount();
  }, [loadHelper, loadRuns, loadAccount]);

  // While there is no usable session, keep checking. The helper retries the
  // saved session on its own timer, so a session that comes back (or a helper
  // that gets started) reconnects the page without a manual reload.
  useEffect(() => {
    if (connected || busy) return;
    const id = setInterval(() => {
      void loadHelper();
      void loadAccount();
    }, 30_000);
    return () => clearInterval(id);
  }, [connected, busy, loadHelper, loadAccount]);

  function togglePerson(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ------------------------------ syncing ------------------------------

  async function sync() {
    setErr("");
    setErrSource("sync");
    setResult(null);
    setEnriched(null);
    setPhase("syncing");
    setProgress("starting");
    setFound(0);
    try {
      const selected = Array.from(selectedIds);
      const scopedThreadIds = Array.from(
        new Set(selected.map((id) => threadIds[id]).filter((t): t is string => Boolean(t))),
      );

      const body: {
        content_types: string[];
        thread_ids: string[];
        sender_ids?: string[];
        date_from?: string;
        date_to?: string;
      } = { content_types: ALL_TYPES, thread_ids: scopedThreadIds };
      if (selected.length > 0) body.sender_ids = selected;
      // date_from is the start of the chosen day; date_to is pushed to the end
      // of its day so an inclusive "To: June 8" actually covers June 8.
      if (dateFrom) body.date_from = new Date(`${dateFrom}T00:00:00`).toISOString();
      if (dateTo) body.date_to = new Date(`${dateTo}T23:59:59.999`).toISOString();

      const start = await fetch("/api/ig/gather", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const startJson = await start.json();
      const { job_id } = startJson;
      if (!job_id) {
        if (startJson.error === "login_required") {
          setNeedsReauth(true);
          setAuthOpen(true);
          setErr("Reel Vault could not use your Instagram session. Refresh it below, then sync again.");
        } else if (startJson.error === "too_soon" || startJson.error === "cooling_down") {
          const hrs = Math.ceil((startJson.retry_after_s ?? 0) / 3600);
          setErr(
            startJson.detail ??
              `Instagram sync is resting to protect your account. Try again in about ${hrs}h.`,
          );
        } else {
          setErr(startJson.detail || startJson.error || "The sync could not be started.");
        }
        setPhase("idle");
        void loadHelper();
        return;
      }

      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await (await fetch(`/api/ig/gather/${job_id}`)).json();
        const st = s.stored ?? {};
        if (s.status === "done" || s.status === "error") {
          setResult({
            items: st.items ?? 0,
            conversations: st.conversations ?? 0,
            messages: st.messages ?? 0,
            skipped: st.skipped ?? 0,
            partial: s.status === "error",
          });
          if (s.status === "error") {
            if (String(s.error ?? "").includes("login_required")) {
              setNeedsReauth(true);
              setAuthOpen(true);
              setErr("Reel Vault could not use your Instagram session. Refresh it below, then sync again.");
            } else {
              setErr(s.detail || s.error || "The sync stopped early.");
            }
          }
          setPhase("idle");
          void loadRuns();
          void loadHelper();
          return;
        }
        setProgress(s.progress ?? "working");
        setFound(s.count ?? 0);
      }
      setPhase("idle");
      void loadRuns();
    } catch {
      setErr("The sync request failed. Check that the local helper is running, then try again.");
      setPhase("idle");
      void loadHelper();
    }
  }

  // ---------------------------- account session ----------------------------

  async function connectWithPassword() {
    setErr("");
    setErrSource("auth");
    setPhase("connecting");
    try {
      const r = await fetch("/api/ig/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
          verification_code: code.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        if (j.error === "2fa_required") {
          setNeeds2fa(true);
          setErr("Instagram sent a 2-factor code. Enter it and try again.");
        } else {
          setErr(j.detail || j.error || "Could not refresh the session.");
        }
        setPhase("idle");
        return;
      }
      setPassword("");
      setCode("");
      setNeeds2fa(false);
      setErr("");
      setPhase("idle");
      await Promise.all([loadAccount(), loadHelper()]);
      setAuthOpen(false);
    } catch {
      setErr(
        "Could not reach the Instagram helper. Start it by double-clicking ig-bridge/start-bridge.command, wait for “running on 127.0.0.1:8765”, then try again.",
      );
      setPhase("idle");
    }
  }

  // Instagram increasingly blocks server password logins with a challenge no
  // script can solve; reusing the browser session avoids it.
  async function connectWithSession() {
    setErr("");
    setErrSource("auth");
    setPhase("connecting");
    try {
      const r = await fetch("/api/ig/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionid: sessionid.trim() }),
      });
      const j = await r.json();
      if (!j.ok) {
        setErr(
          j.detail || j.error || "That session id did not work. Copy it again from a logged-in instagram.com tab.",
        );
        setPhase("idle");
        return;
      }
      setSessionid("");
      setErr("");
      setPhase("idle");
      await Promise.all([loadAccount(), loadHelper()]);
      setAuthOpen(false);
    } catch {
      setErr("Could not reach the Instagram helper. Start it, then try again.");
      setPhase("idle");
    }
  }

  async function disconnect() {
    setDisconnecting(true);
    setErr("");
    try {
      await fetch("/api/ig/logout", { method: "POST" });
    } catch {
      /* best effort; clear the UI regardless */
    }
    setAccount(null);
    setUsername("");
    setPassword("");
    setCode("");
    setNeeds2fa(false);
    setSessionid("");
    setResult(null);
    setProgress("");
    setPhase("idle");
    setPeople([]);
    setThreadIds({});
    setSelectedIds(new Set());
    setDateFrom("");
    setDateTo("");
    setAuthOpen(true);
    setDisconnecting(false);
    void loadHelper();
  }

  async function enrich() {
    setEnriching(true);
    setEnrichErr("");
    setEnriched(null);
    try {
      const res = await fetch("/api/enrich-pending", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setEnrichErr((data && (data.error as string)) || "Enrichment could not be started.");
        return;
      }
      setEnriched(Number(data?.enriched ?? 0));
    } catch {
      setEnrichErr("Something went wrong while enriching. Try again.");
    } finally {
      setEnriching(false);
    }
  }

  // ------------------------------ rendering ------------------------------

  const helperCopy: Record<Helper["state"], [string, string]> = {
    checking: ["Checking", "Asking the helper on this machine whether it is running."],
    running: ["Running", "Your account session is available on this machine."],
    offline: [
      "Offline",
      "Start it by double-clicking ig-bridge/start-bridge.command and waiting for “running on 127.0.0.1:8765”.",
    ],
    auth_required: ["Authentication required", "The helper is running but holds no Instagram session."],
    session_expired: [
      "Session expired",
      "Instagram stopped accepting the saved session. The helper keeps retrying it on its own; paste a fresh session id below to reconnect now.",
    ],
    cooling_down: [
      "Resting",
      helper.cooldownReason
        ? `Instagram pushed back (${helper.cooldownReason}). Syncing is paused to protect the account.`
        : "Instagram pushed back. Syncing is paused for a while to protect the account.",
    ],
  };

  const stageIndex = STAGES.findIndex(([key]) => key === progress);

  return (
    <Shell>
      <div className="mx-auto max-w-2xl space-y-4 pb-10">
        {/* 1 · Header */}
        <div className={PANEL}>
          <div className={PANEL_HEADER}>
            <span>Sync</span>
            <span>
              {connected
                ? "CONNECTED"
                : helper.state === "session_expired"
                  ? "SESSION EXPIRED"
                  : "NOT CONNECTED"}
            </span>
          </div>
          <div className="px-4 py-3">
            <h1 className="font-display text-[20px] leading-tight">Sync Your Account</h1>
            <p className="mt-2 max-w-[60ch] text-[13px] leading-relaxed">
              Keep your saved posts, reels, and shared content up to date.
            </p>
          </div>
        </div>

        {/* 2 · Account + session status, then the one action */}
        <section className="hand bg-paper px-4 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <span
              aria-hidden
              className="grid h-10 w-10 shrink-0 place-items-center stipple-1 font-display text-lg font-semibold text-ink"
            >
              {(account?.username ?? helper.username ?? "?").charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="text-[12px] uppercase tracking-wide">Instagram account</p>
              <p className="truncate font-display text-[16px]">
                {account?.username ? `@${account.username}` : "No account connected"}
                {account?.full_name ? <span className="text-[13px]"> · {account.full_name}</span> : null}
              </p>
            </div>
            <span
              className={`ml-auto shrink-0 px-2 py-1 font-display text-[12px] ${
                connected ? "bg-ink text-paper" : "hand"
              }`}
            >
              {connected
                ? "Connected"
                : helper.state === "session_expired"
                  ? "Session expired"
                  : "Not connected"}
            </span>
          </div>

          <dl className="mt-4 grid gap-3 border-t-2 border-dotted border-ink pt-3 text-[13px] sm:grid-cols-2">
            <div>
              <dt className="text-[12px] uppercase tracking-wide">Last synced</dt>
              <dd className="tabular">{lastRun ? <RelativeTime iso={lastRun.started_at} /> : "Never"}</dd>
            </div>
            <div>
              <dt className="text-[12px] uppercase tracking-wide">Next sync available</dt>
              <dd className="tabular">
                {/* "now" only means something once there is an account to sync. */}
                {!connected || helper.state === "offline" || helper.state === "checking"
                  ? "—"
                  : hoursLabel(helper.nextGatherInS ?? 0)}
              </dd>
            </div>
          </dl>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={sync}
              disabled={busy || !connected || helper.state === "offline"}
              className={BUTTON_PRIMARY}
            >
              {phase === "syncing" ? "Syncing…" : scoped ? "Sync Selected" : "Sync Now"}
            </button>
            {scoped && !busy && (
              <span className="text-[12px]">
                Scoped by the sync options below.{" "}
                <button
                  type="button"
                  onClick={() => {
                    setSelectedIds(new Set());
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="underline decoration-2 underline-offset-2 hover:bg-ink hover:text-paper hover:no-underline"
                >
                  Clear
                </button>
              </span>
            )}
            {!connected && !busy && (
              <span className="text-[12px]">
                {helper.state === "session_expired" ? (
                  <>
                    Instagram ended your session. Paste a fresh session id under{" "}
                    <em>Account session</em> to sync again.
                  </>
                ) : (
                  <>
                    Connect a session under <em>Account session</em> to enable syncing.
                  </>
                )}
              </span>
            )}
          </div>

          {/* Live progress: a sync runs for minutes with no navigation. */}
          {phase === "syncing" && (
            <div role="status" className="mt-4 border-2 border-ink px-4 py-3">
              <ul className="space-y-1 text-[13px]">
                {STAGES.map(([key, label], i) => {
                  const state =
                    stageIndex < 0 ? "pending" : i < stageIndex ? "done" : i === stageIndex ? "now" : "pending";
                  return (
                    <li key={key} className={state === "pending" ? "opacity-40" : ""}>
                      <span aria-hidden className="mr-2 font-display">
                        {state === "done" ? "✓" : state === "now" ? "›" : "·"}
                      </span>
                      {label}
                      {state === "now" && <span className="tabular"> — {found} found</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="mt-4 space-y-3 border-2 border-ink px-4 py-3">
              <p className="font-display text-[15px]">
                {result.partial ? "Sync stopped early" : "Sync complete"}
              </p>
              <dl className="grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-4">
                <div>
                  <dt className="text-[12px] uppercase tracking-wide">Items</dt>
                  <dd className="tabular">{result.items}</dd>
                </div>
                <div>
                  <dt className="text-[12px] uppercase tracking-wide">Conversations</dt>
                  <dd className="tabular">{result.conversations}</dd>
                </div>
                <div>
                  <dt className="text-[12px] uppercase tracking-wide">Messages</dt>
                  <dd className="tabular">{result.messages}</dd>
                </div>
                <div>
                  <dt className="text-[12px] uppercase tracking-wide">Skipped</dt>
                  <dd className="tabular">{result.skipped}</dd>
                </div>
              </dl>
              <Link href="/" className="inline-block underline-offset-2 hover:underline">
                Open the vault →
              </Link>
              <div className="space-y-2 border-t-2 border-dotted border-ink pt-3">
                <p className="text-[13px] leading-relaxed">
                  Let AI read the new items and fill in summaries, categories, and tags.
                </p>
                <button type="button" onClick={enrich} disabled={enriching} className={BUTTON}>
                  {enriching ? "Enriching…" : "Enrich with AI"}
                </button>
                <p aria-live="polite" className="tabular text-[13px]">
                  {enriched !== null ? `Enriched ${enriched} ${enriched === 1 ? "item" : "items"}.` : ""}
                </p>
                {enrichErr && (
                  <p role="alert" className="text-[13px]">
                    {enrichErr}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Error state: explain, offer Try Again, and only point at
              reauthentication when Instagram actually asked for it. */}
          {err && (
            <div role="alert" className="mt-4 space-y-2 border-2 border-ink stipple-1 px-4 py-3">
              <p className="font-display text-[15px]">
                {errSource === "auth"
                  ? "Instagram didn’t accept that sign-in"
                  : needsReauth
                    ? "Your Instagram session needs to be refreshed"
                    : "Sync couldn’t be completed"}
              </p>
              <p className="text-[13px] leading-relaxed">{err}</p>
              <div className="flex flex-wrap gap-2">
                {errSource === "sync" && (
                  <button type="button" onClick={sync} disabled={busy || !connected} className={BUTTON}>
                    Try Again
                  </button>
                )}
                {(needsReauth || errSource === "auth") && (
                  <button
                    type="button"
                    onClick={() => {
                      setAuthOpen(true);
                      document.getElementById("account-session")?.scrollIntoView({ behavior: "smooth" });
                    }}
                    className={BUTTON}
                  >
                    {errSource === "auth" ? "Back to sign-in" : "Refresh Session"}
                  </button>
                )}
              </div>
            </div>
          )}
        </section>

        {/* 3 · What gets synced */}
        <section className={PANEL}>
          <div className={PANEL_HEADER}>
            <span>What gets synced</span>
          </div>
          <ul className="divide-y-2 divide-dotted divide-ink px-4">
            {SYNCED.map(([name, detail]) => (
              <li key={name} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:gap-4">
                <span className="font-display text-[14px] sm:w-40 sm:shrink-0">{name}</span>
                <span className="text-[13px] leading-relaxed">{detail}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Pictures and clips. Instagram signs its media URLs with an expiry,
            so a card kept for a few weeks loses its picture. This pulls the
            bytes onto the machine, where they stop expiring, and reports what
            has already gone dead. */}
        <section className={PANEL}>
          <div className={PANEL_HEADER}>
            <span>Pictures and clips</span>
            <span>LOCAL COPIES</span>
          </div>
          <div className="space-y-3 px-4 py-3">
            <p className="max-w-[62ch] text-[13px] leading-relaxed">
              Instagram serves pictures from links that expire. Reel Vault now
              copies every picture and clip onto this machine as it arrives, so
              they stop expiring. Run this once to pull in anything still
              reachable; whatever has already lapsed needs a fresh sync.
            </p>
            <button
              type="button"
              onClick={repairMedia}
              disabled={repairing}
              className={BUTTON}
            >
              {repairing ? "Pulling media in…" : "Hold Media On This Machine"}
            </button>
            <p aria-live="polite" className="tabular text-[13px]">
              {repairResult}
            </p>
          </div>
        </section>

        {/* 4 · Sync frequency. There is no scheduler in Reel Vault; the only
            recurring behaviour is the helper's minimum interval, so say that
            rather than pretending an automatic sync exists. */}
        <section className={PANEL}>
          <div className={PANEL_HEADER}>
            <span>Sync frequency</span>
            <span>MANUAL</span>
          </div>
          <div className="space-y-1 px-4 py-3 text-[13px] leading-relaxed">
            <p>
              Reel Vault syncs when you press <strong>Sync Now</strong>. There is no automatic schedule.
            </p>
            {helper.minIntervalHours ? (
              <p>
                To keep the account safe, the helper allows one sync every{" "}
                <span className="tabular">{Math.round(helper.minIntervalHours)}h</span>
                {helper.lastGatherAt ? (
                  <>
                    {" "}
                    — last run <RelativeTime iso={helper.lastGatherAt} />, next available{" "}
                    {hoursLabel(helper.nextGatherInS ?? 0)}.
                  </>
                ) : (
                  "."
                )}
              </p>
            ) : null}
          </div>
        </section>

        {/* 5 · History */}
        <section className={PANEL}>
          <div className={PANEL_HEADER}>
            <span>Recent syncs</span>
          </div>
          {runs.length === 0 ? (
            <p className="px-4 py-3 text-[13px]">
              No syncs yet. The first <strong>Sync Now</strong> will show up here.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[20rem] text-left text-[13px]">
                <thead className="font-display text-[12px] uppercase tracking-wide">
                  <tr className="border-b-2 border-dotted border-ink">
                    <th scope="col" className="px-4 py-2">
                      Date
                    </th>
                    <th scope="col" className="px-4 py-2">
                      Status
                    </th>
                    <th scope="col" className="px-4 py-2">
                      Result
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="border-b-2 border-dotted border-ink last:border-0">
                      <td className="px-4 py-2">
                        <RelativeTime iso={r.started_at} />
                      </td>
                      <td className="px-4 py-2">{r.status === "done" ? "Completed" : "Stopped early"}</td>
                      <td className="tabular px-4 py-2">
                        {r.items} items{r.messages > 0 ? `, ${r.messages} messages` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* 6 · Local helper */}
        <section className={PANEL}>
          <div className={PANEL_HEADER}>
            <span>Local helper</span>
            <span>{helperCopy[helper.state][0].toUpperCase()}</span>
          </div>
          <div className="space-y-2 px-4 py-3">
            <p className="text-[13px] leading-relaxed">{helperCopy[helper.state][1]}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={loadHelper} className={BUTTON_SMALL}>
                Check again
              </button>
              {(helper.state === "auth_required" || helper.state === "session_expired") && (
                <button
                  type="button"
                  onClick={() => {
                    setAuthOpen(true);
                    document.getElementById("account-session")?.scrollIntoView({ behavior: "smooth" });
                  }}
                  className={BUTTON_SMALL}
                >
                  Refresh session
                </button>
              )}
              {helper.state === "session_expired" && (helper.sessionRetryInS ?? 0) > 0 && (
                <span className="self-center text-[12px]">
                  Retrying in {helper.sessionRetryInS}s
                </span>
              )}
            </div>
          </div>
        </section>

        {/* 7 · Privacy, kept short and in context */}
        <p className="hand bg-paper px-4 py-3 text-[13px] leading-relaxed">
          Your credentials stay on this machine. The local helper handles synchronization without
          sending them to the Reel Vault service. Automated access is against Instagram’s terms and
          carries a real, if low, risk of a temporary lock — which is why the helper signs in once,
          reuses that session, and rate-limits itself.
        </p>

        {/* 8 · Advanced: scope, then authentication */}
        <details className="hand bg-paper px-4 py-3">
          <summary className="cursor-pointer font-display text-[14px]">Sync options</summary>
          <div className="mt-3 space-y-5">
            <p className="text-[13px] leading-relaxed">
              Optional. Leave the dates blank and no one selected to sync your whole account.
            </p>

            <div className="space-y-2">
              <p className="text-[12px] uppercase tracking-wide">Date range</p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-[12px]">
                  From
                  <input
                    type="date"
                    value={dateFrom}
                    max={dateTo || undefined}
                    onChange={(e) => setDateFrom(e.target.value)}
                    disabled={busy}
                    className="hand bg-paper px-3 py-2 text-[14px] outline-none disabled:opacity-50"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12px]">
                  To
                  <input
                    type="date"
                    value={dateTo}
                    min={dateFrom || undefined}
                    onChange={(e) => setDateTo(e.target.value)}
                    disabled={busy}
                    className="hand bg-paper px-3 py-2 text-[14px] outline-none disabled:opacity-50"
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setDateFrom(daysAgoISO(3));
                    setDateTo("");
                  }}
                  disabled={busy}
                  className={BUTTON_SMALL}
                >
                  Last 3 days
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDateFrom("");
                    setDateTo("");
                  }}
                  disabled={busy}
                  className={BUTTON_SMALL}
                >
                  All time
                </button>
              </div>
            </div>

            {people.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-[12px] uppercase tracking-wide">People and threads</p>
                  {selectedIds.size > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedIds(new Set())}
                      disabled={busy}
                      className="font-display text-[12px] underline decoration-2 underline-offset-2 hover:bg-ink hover:text-paper hover:no-underline disabled:opacity-40"
                    >
                      Clear ({selectedIds.size})
                    </button>
                  )}
                </div>
                <p className="text-[12px]">
                  None selected syncs everyone. Pick names to sync only their shares.
                </p>
                <ul className="max-h-56 space-y-1 overflow-y-auto overscroll-contain pr-1">
                  {people.map((p) => (
                    <li key={p.id}>
                      <label className="flex cursor-pointer items-center gap-2.5 px-2 py-1.5 text-[14px] hover:stipple-1">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(p.id)}
                          onChange={() => togglePerson(p.id)}
                          disabled={busy}
                          className="size-4 shrink-0 accent-black disabled:opacity-50"
                        />
                        <span className="truncate">{p.label}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>

        <details
          id="account-session"
          open={authOpen || !connected}
          onToggle={(e) => setAuthOpen((e.currentTarget as HTMLDetailsElement).open)}
          className="hand bg-paper px-4 py-3"
        >
          <summary className="cursor-pointer font-display text-[14px]">Account session</summary>
          <div className="mt-3 space-y-5">
            <p className="text-[13px] leading-relaxed">
              {connected
                ? "Your session is already connected — you only need this if Instagram asks you to sign in again, or to switch to a different account."
                : "Reel Vault needs an Instagram session on this machine before it can sync."}
            </p>

            {/* Session id first: Instagram blocks server password logins with a
                challenge no script can solve, so this is the path that works. */}
            <div className="space-y-2">
              <p className="font-display text-[14px]">Refresh with a session id</p>
              <p className="text-[12px] leading-relaxed">
                On a desktop browser logged in to instagram.com: DevTools (F12) → Application →
                Cookies → <span translate="no">https://www.instagram.com</span> → copy the value of{" "}
                <code translate="no" className="stipple-1 px-1 font-mono">
                  sessionid
                </code>
                . This avoids the challenge and is the lower-risk path.
              </p>
              <label htmlFor="ig-sessionid" className="block text-[12px] uppercase tracking-wide">
                Session id
              </label>
              <input
                id="ig-sessionid"
                name="sessionid"
                className={FIELD}
                value={sessionid}
                onChange={(e) => setSessionid(e.target.value)}
                placeholder="sessionid cookie value"
                type="password"
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  if (busy || !sessionid.trim()) return;
                  void connectWithSession();
                }}
              />
              <button
                type="button"
                onClick={connectWithSession}
                disabled={busy || !sessionid.trim()}
                className={BUTTON}
              >
                {phase === "connecting" ? "Refreshing…" : "Refresh Session"}
              </button>
            </div>

            <form
              className="space-y-3 border-t-2 border-dotted border-ink pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (busy || !username.trim() || !password) return;
                void connectWithPassword();
              }}
            >
              <p className="font-display text-[14px]">Or sign in with a password</p>
              <div className="space-y-1.5">
                <label htmlFor="ig-username" className="block text-[12px] uppercase tracking-wide">
                  Instagram username
                </label>
                <input
                  id="ig-username"
                  name="username"
                  className={FIELD}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="yourhandle"
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="none"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="ig-password" className="block text-[12px] uppercase tracking-wide">
                  Password
                </label>
                <input
                  id="ig-password"
                  name="password"
                  className={FIELD}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your Instagram password"
                  type="password"
                  autoComplete="current-password"
                  spellCheck={false}
                />
              </div>
              {needs2fa && (
                <div className="space-y-1.5">
                  <label htmlFor="ig-code" className="block text-[12px] uppercase tracking-wide">
                    Two-factor code
                  </label>
                  <input
                    id="ig-code"
                    name="one-time-code"
                    className={FIELD}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="6-digit code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    spellCheck={false}
                  />
                </div>
              )}
              <button type="submit" disabled={busy || !username.trim() || !password} className={BUTTON}>
                {phase === "connecting" ? "Signing in…" : needs2fa ? "Verify" : "Sign In"}
              </button>
            </form>

            {connected && (
              <div className="space-y-2 border-t-2 border-dotted border-ink pt-4">
                <p className="font-display text-[14px]">Switch account</p>
                <p className="text-[12px] leading-relaxed">
                  Signs out of the helper and forgets the saved session so a different account can be
                  connected.
                </p>
                {confirmingDisconnect ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmingDisconnect(false);
                        void disconnect();
                      }}
                      disabled={busy || disconnecting}
                      className={BUTTON}
                    >
                      {disconnecting ? "Signing out…" : "Sign Out"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingDisconnect(false)}
                      disabled={disconnecting}
                      className={BUTTON_SMALL}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingDisconnect(true)}
                    disabled={busy || disconnecting}
                    className={BUTTON_SMALL}
                  >
                    Switch Account
                  </button>
                )}
              </div>
            )}
          </div>
        </details>
      </div>
    </Shell>
  );
}
