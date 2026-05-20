import { describe, it, expect } from "vitest";
import { parseOembed, parseOpenGraph, detectSource } from "./metadata";

describe("parseOembed", () => {
  it("extracts title, author, thumbnail", () => {
    const json = {
      title: "How to edit a video",
      author_name: "creator123",
      thumbnail_url: "https://cdn/thumb.jpg",
    };
    expect(parseOembed(json)).toEqual({
      title: "How to edit a video",
      author: "creator123",
      thumbnail: "https://cdn/thumb.jpg",
      caption: "How to edit a video",
    });
  });
});

describe("parseOpenGraph", () => {
  it("extracts og tags from html", () => {
    const html = `<html><head>
      <meta property="og:title" content="Color grading basics" />
      <meta property="og:image" content="https://cdn/og.jpg" />
      <meta property="og:description" content="A short guide" />
    </head></html>`;
    expect(parseOpenGraph(html)).toEqual({
      title: "Color grading basics",
      author: undefined,
      thumbnail: "https://cdn/og.jpg",
      caption: "A short guide",
    });
  });

  it("falls back to <title> when og:title missing", () => {
    const html = `<html><head><title>Fallback Title</title></head></html>`;
    expect(parseOpenGraph(html).title).toBe("Fallback Title");
  });
});

describe("detectSource", () => {
  it("classifies instagram urls", () => {
    expect(detectSource("https://www.instagram.com/reel/abc/")).toBe("instagram");
  });
  it("classifies other urls as article", () => {
    expect(detectSource("https://example.com/post")).toBe("article");
  });
});
