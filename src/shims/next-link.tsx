import type { AnchorHTMLAttributes, Ref } from "react";
import { Link as RouterLink } from "react-router";

// ponytail: next/link's `href` API over react-router's Link, so the 15 components
// that link between cards keep their imports. Absolute and /api URLs stay plain <a>.
type Props = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  prefetch?: boolean;
  scroll?: boolean;
  replace?: boolean;
  ref?: Ref<HTMLAnchorElement>;
};

export default function Link({ href, prefetch: _p, scroll: _s, replace, ...rest }: Props) {
  if (/^[a-z]+:/i.test(href) || href.startsWith("/api/") || href.startsWith("#")) {
    return <a href={href} {...rest} />;
  }
  return <RouterLink to={href} replace={replace} {...rest} />;
}
