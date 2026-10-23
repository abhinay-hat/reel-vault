import { describe, it, expect } from "vitest";
import { buildEnrichPrompt, parseEnrichResponse } from "./ai";

describe("buildEnrichPrompt", () => {
  it("includes title and caption", () => {
    const p = buildEnrichPrompt("Edit a video", "Step by step tutorial");
    expect(p).toContain("Edit a video");
    expect(p).toContain("Step by step tutorial");
  });
});

describe("parseEnrichResponse", () => {
  it("parses a clean JSON object", () => {
    const raw = '{"summary":"A tutorial","category":"Video Editing","tags":["editing","tutorial"]}';
    expect(parseEnrichResponse(raw)).toEqual({
      summary: "A tutorial",
      category: "Video Editing",
      tags: ["editing", "tutorial"],
    });
  });

  it("parses JSON wrapped in markdown fences", () => {
    const raw = '```json\n{"summary":"x","category":"y","tags":[]}\n```';
    expect(parseEnrichResponse(raw)).toEqual({
      summary: "x",
      category: "y",
      tags: [],
    });
  });

  it("returns empty defaults on invalid JSON", () => {
    expect(parseEnrichResponse("not json")).toEqual({
      summary: "",
      category: "",
      tags: [],
    });
  });
});
