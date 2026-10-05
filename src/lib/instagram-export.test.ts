import { describe, it, expect } from "vitest";
import { parseSavedPosts, parseLikedPosts, parseInbox, fixMojibake } from "./instagram-export";

describe("fixMojibake", () => {
  it("repairs double-encoded UTF-8 from Meta exports", () => {
    // "ą" (U+0105) exported as UTF-8 bytes 0xC4 0x85 escaped as code points
    expect(fixMojibake("Ä")).toBe("ą");
    // emoji 😀 = F0 9F 98 80
    expect(fixMojibake("ð")).toBe("😀");
  });
  it("leaves plain ASCII and real unicode untouched", () => {
    expect(fixMojibake("hello")).toBe("hello");
    expect(fixMojibake("日本語")).toBe("日本語");
  });
  it("keeps strings that are not valid UTF-8 byte sequences", () => {
    expect(fixMojibake("café")).toBe("café"); // lone é is real latin-1 text
  });
});

describe("parseSavedPosts", () => {
  it("extracts urls from the saved_posts JSON shape", () => {
    const json = {
      saved_saved_media: [
        {
          title: "creatorA",
          string_map_data: {
            "Saved on": {
              href: "https://www.instagram.com/reel/AAA/",
              timestamp: 1700000000,
            },
          },
        },
        {
          title: "creatorB",
          string_map_data: {
            "Saved on": {
              href: "https://www.instagram.com/reel/BBB/",
              timestamp: 1700000100,
            },
          },
        },
      ],
    };
    expect(parseSavedPosts(JSON.stringify(json))).toEqual([
      { url: "https://www.instagram.com/reel/AAA/", author: "creatorA" },
      { url: "https://www.instagram.com/reel/BBB/", author: "creatorB" },
    ]);
  });

  it("returns empty array on malformed input", () => {
    expect(parseSavedPosts("garbage")).toEqual([]);
  });

  it("falls back to the first array key if saved_saved_media is renamed", () => {
    const json = {
      some_other_key: [
        { title: "creatorC", string_list_data: [{ href: "https://www.instagram.com/p/CCC/" }] },
      ],
    };
    expect(parseSavedPosts(JSON.stringify(json))).toEqual([
      { url: "https://www.instagram.com/p/CCC/", author: "creatorC" },
    ]);
  });
});

describe("parseLikedPosts", () => {
  it("extracts urls from the liked_posts JSON shape", () => {
    const json = {
      likes_media_likes: [
        { title: "creatorA", string_list_data: [{ href: "https://www.instagram.com/reel/AAA/", timestamp: 1700000000 }] },
      ],
    };
    expect(parseLikedPosts(JSON.stringify(json))).toEqual([
      { url: "https://www.instagram.com/reel/AAA/", author: "creatorA" },
    ]);
  });
  it("returns empty array on malformed input", () => {
    expect(parseLikedPosts("garbage")).toEqual([]);
  });
});

describe("parseInbox", () => {
  const raw = JSON.stringify({
    participants: [{ name: "me" }, { name: "creatorA" }],
    title: "creatorA",
    thread_path: "inbox/creatora_123",
    messages: [
      { sender_name: "creatorA", timestamp_ms: 1700000000000, content: "hey check this",
        share: { link: "https://www.instagram.com/reel/AAA/" } },
      { sender_name: "me", timestamp_ms: 1700000100000, content: "nice" },
    ],
  });
  it("parses a thread into conversation + messages", () => {
    const t = parseInbox(raw);
    expect(t).not.toBeNull();
    expect(t!.threadKey).toBe("inbox/creatora_123");
    expect(t!.title).toBe("creatorA");
    expect(t!.participants).toEqual(["me", "creatorA"]);
    expect(t!.messages).toHaveLength(2);
    expect(t!.messages[0]).toEqual({
      externalId: "creatorA:1700000000000", sender: "creatorA",
      content: "hey check this", sentAt: 1700000000000,
      sharedUrl: "https://www.instagram.com/reel/AAA/",
    });
    expect(t!.messages[1].sharedUrl).toBeUndefined();
  });
  it("returns null on malformed input", () => {
    expect(parseInbox("garbage")).toBeNull();
  });
});
