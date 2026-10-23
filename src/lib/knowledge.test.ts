import { describe, it, expect } from "vitest";
import { buildKnowledgePrompt, parseKnowledgeResponse } from "./ai";

describe("buildKnowledgePrompt", () => {
  it("labels each source so the model can weigh them differently", () => {
    const p = buildKnowledgePrompt({
      title: "3 job portals",
      caption: "save this",
      transcript: "so the first one is wellfound",
      onScreenText: "1. Wellfound",
    });
    expect(p).toContain("Caption (the poster's own words)");
    expect(p).toContain("Text shown on screen");
    expect(p).toContain("Spoken transcript");
    expect(p).toContain("wellfound");
  });

  it("omits sections that have no content", () => {
    const p = buildKnowledgePrompt({ title: "x", caption: "only a caption" });
    expect(p).toContain("Caption");
    expect(p).not.toContain("Spoken transcript");
    expect(p).not.toContain("Text shown on screen");
  });

  it("caps a long transcript so one rambling reel cannot blow the context", () => {
    const p = buildKnowledgePrompt({ title: "x", transcript: "word ".repeat(5000) });
    expect(p.length).toBeLessThan(9000);
  });
});

describe("parseKnowledgeResponse", () => {
  it("parses a full record", () => {
    const raw = JSON.stringify({
      summary: "Three job boards for remote startup roles.",
      category: "Job Portals",
      tags: ["jobs", "remote"],
      entities: [
        { kind: "job_portal", name: "Wellfound", url: "https://wellfound.com" },
        { kind: "job_portal", name: "Otta", note: "curated matches" },
      ],
      actions: ["Make a Wellfound profile"],
    });
    const k = parseKnowledgeResponse(raw);
    expect(k.summary).toBe("Three job boards for remote startup roles.");
    expect(k.category).toBe("Job Portals");
    expect(k.entities).toHaveLength(2);
    expect(k.entities[0].url).toBe("https://wellfound.com");
    expect(k.actions).toEqual(["Make a Wellfound profile"]);
  });

  it("recovers JSON that the model prefixed with prose", () => {
    const raw = 'Sure! Here is the JSON:\n{"summary":"A anime rec","category":"Anime","tags":["anime"]}';
    expect(parseKnowledgeResponse(raw).summary).toBe("A anime rec");
  });

  it("parses fenced JSON", () => {
    const raw = '```json\n{"summary":"s","category":"c","tags":[]}\n```';
    expect(parseKnowledgeResponse(raw).category).toBe("c");
  });

  it("degrades field by field instead of losing the whole record", () => {
    // A broken entities array must not cost us the summary — enrichment runs
    // unattended and a partial record still beats no record.
    const raw = '{"summary":"kept","category":"Anime","tags":"not-an-array","entities":"oops"}';
    const k = parseKnowledgeResponse(raw);
    expect(k.summary).toBe("kept");
    expect(k.tags).toEqual([]);
    expect(k.entities).toEqual([]);
  });

  it("drops entities with no name but keeps their siblings", () => {
    const raw = JSON.stringify({
      summary: "s", category: "c", tags: [],
      entities: [{ kind: "movie" }, { kind: "movie", name: "Dune" }, "junk"],
    });
    const k = parseKnowledgeResponse(raw);
    expect(k.entities).toEqual([{ kind: "movie", name: "Dune" }]);
  });

  it("relabels an unknown entity kind as other rather than discarding the name", () => {
    const raw = JSON.stringify({
      summary: "s", category: "c", tags: [],
      entities: [{ kind: "spaceship", name: "Serenity" }],
    });
    expect(parseKnowledgeResponse(raw).entities[0]).toEqual({ kind: "other", name: "Serenity" });
  });

  it("lowercases tags so the same tag does not fragment by casing", () => {
    const raw = '{"summary":"s","category":"c","tags":["Jobs","REMOTE"]}';
    expect(parseKnowledgeResponse(raw).tags).toEqual(["jobs", "remote"]);
  });

  it("returns an empty record for unparseable output", () => {
    expect(parseKnowledgeResponse("I could not do that")).toEqual({
      summary: "", category: "", tags: [], entities: [], actions: [],
    });
  });
});
