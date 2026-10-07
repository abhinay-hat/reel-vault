import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";

export type Loaded<T> =
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "missing" }
  | { state: "error" };

/**
 * GET a JSON endpoint for a page. Refetches when the URL or the location key
 * changes (router.refresh() re-dispatches the location). A 401 means the
 * passcode gate is on and this browser has no cookie: go sign in.
 */
export function useJson<T>(url: string): Loaded<T> {
  const location = useLocation();
  const navigate = useNavigate();
  const [result, setResult] = useState<Loaded<T>>({ state: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(url, { signal: ctrl.signal })
      .then(async (res) => {
        if (res.status === 401) return navigate("/login", { replace: true });
        if (res.status === 404) return setResult({ state: "missing" });
        if (!res.ok) return setResult({ state: "error" });
        setResult({ state: "ready", data: (await res.json()) as T });
      })
      .catch((err: unknown) => {
        if ((err as Error).name !== "AbortError") setResult({ state: "error" });
      });
    return () => ctrl.abort();
  }, [url, location.key, navigate]);

  return result;
}
