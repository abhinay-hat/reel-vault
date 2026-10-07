// ponytail: the slice of next/server the API handlers use, over Web Request/Response,
// so the 19 route.ts files run under Hono unchanged. Rename imports to these
// names directly if the Next vocabulary ever gets in the way.

export class NextRequest extends Request {
  readonly nextUrl: URL;

  constructor(input: Request | string | URL, init?: RequestInit) {
    super(input, init);
    this.nextUrl = new URL(this.url);
  }
}

interface CookieOptions {
  httpOnly?: boolean;
  sameSite?: "lax" | "strict" | "none";
  maxAge?: number;
  path?: string;
  secure?: boolean;
}

export class NextResponse extends Response {
  readonly cookies = {
    set: (name: string, value: string, o: CookieOptions = {}) => {
      const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? "/"}`];
      if (o.maxAge !== undefined) parts.push(`Max-Age=${o.maxAge}`);
      if (o.httpOnly) parts.push("HttpOnly");
      if (o.secure) parts.push("Secure");
      if (o.sameSite) parts.push(`SameSite=${o.sameSite[0].toUpperCase()}${o.sameSite.slice(1)}`);
      this.headers.append("Set-Cookie", parts.join("; "));
    },
  };

  static json(body: unknown, init?: ResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    headers.set("Content-Type", "application/json");
    return new NextResponse(JSON.stringify(body), { ...init, headers });
  }

  static redirect(url: string | URL, status = 307): NextResponse {
    return new NextResponse(null, { status, headers: { Location: String(url) } });
  }
}
