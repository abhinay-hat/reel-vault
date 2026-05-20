import { describe, it, expect } from "vitest";
import { parseSavedPosts } from "./instagram-export";

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
});
