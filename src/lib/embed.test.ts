import { describe, expect, it } from "vitest";
import { instagramEmbed } from "./db";

describe("instagramEmbed", () => {
  it("maps reel and post permalinks to Instagram's embed player", () => {
    expect(
      instagramEmbed("https://www.instagram.com/reel/CuPZ6dAxSyb/?id=3138841433344388251_22009575863"),
    ).toBe("https://www.instagram.com/reel/CuPZ6dAxSyb/embed/");
    expect(instagramEmbed("https://instagram.com/p/AbC_12-x/")).toBe(
      "https://www.instagram.com/p/AbC_12-x/embed/",
    );
    expect(instagramEmbed("https://www.instagram.com/someuser/reel/XyZ123/")).toBe(
      "https://www.instagram.com/reel/XyZ123/embed/",
    );
  });

  it("returns null for anything that is not a reel or post", () => {
    expect(instagramEmbed("https://example.com/article")).toBeNull();
    expect(instagramEmbed(null)).toBeNull();
  });
});
