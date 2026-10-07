import { useMemo } from "react";
import { useLocation, useNavigate, useSearchParams as useRouterSearchParams } from "react-router";

// ponytail: next/navigation hooks over react-router for the few client
// components that use them. refresh() re-dispatches the current location so
// pages refetch (they key their data loads on location.key).

export function useRouter() {
  const navigate = useNavigate();
  const location = useLocation();
  return useMemo(
    () => ({
      push: (to: string) => navigate(to),
      replace: (to: string) => navigate(to, { replace: true }),
      back: () => navigate(-1),
      refresh: () => navigate(location.pathname + location.search, { replace: true, state: { refresh: Date.now() } }),
    }),
    [navigate, location.pathname, location.search],
  );
}

export function usePathname(): string {
  return useLocation().pathname;
}

export function useSearchParams(): URLSearchParams {
  return useRouterSearchParams()[0];
}
