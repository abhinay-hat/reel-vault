export interface Metadata {
  title: string;
  author?: string;
  thumbnail?: string;
  caption?: string;
}

export function parseOembed(json: {
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
}): Metadata {
  return {
    title: json.title ?? "Untitled",
    author: json.author_name,
    thumbnail: json.thumbnail_url,
    caption: json.title,
  };
}

function metaContent(html: string, property: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const m = html.match(re);
  return m ? m[1] : undefined;
}

export function parseOpenGraph(html: string): Metadata {
  const ogTitle = metaContent(html, "og:title");
  const tagTitle = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  return {
    title: ogTitle ?? tagTitle ?? "Untitled",
    author: metaContent(html, "article:author") ?? metaContent(html, "author"),
    thumbnail: metaContent(html, "og:image"),
    caption: metaContent(html, "og:description"),
  };
}

export type Source = "instagram" | "article" | "other";

export function detectSource(url: string): Source {
  if (/instagram\.com/i.test(url)) return "instagram";
  try {
    new URL(url);
    return "article";
  } catch {
    return "other";
  }
}
