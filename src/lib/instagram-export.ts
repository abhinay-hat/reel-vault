export interface SavedPost {
  url: string;
  author?: string;
}

export function parseSavedPosts(rawJson: string): SavedPost[] {
  try {
    const data = JSON.parse(rawJson);
    const list = data.saved_saved_media;
    if (!Array.isArray(list)) return [];
    const out: SavedPost[] = [];
    for (const entry of list) {
      const href = entry?.string_map_data?.["Saved on"]?.href;
      if (typeof href === "string" && href.startsWith("http")) {
        out.push({
          url: href,
          author: typeof entry.title === "string" ? entry.title : undefined,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}
