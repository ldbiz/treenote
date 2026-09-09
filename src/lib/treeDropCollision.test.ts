import { describe, expect, it } from "vitest";
import {
  ROOT_DROP_AREA_ID,
  pickPreferredTreeDropId,
} from "./treeDropCollision";

describe("pickPreferredTreeDropId", () => {
  it("prefers the tree row under the pointer over the panel drop area", () => {
    expect(
      pickPreferredTreeDropId(
        [ROOT_DROP_AREA_ID, "scratch"],
        new Map([
          [ROOT_DROP_AREA_ID, 100_000],
          ["scratch", 3_000],
        ]),
      ),
    ).toBe("scratch");
  });

  it("prefers the smaller row when parent and child rects overlap", () => {
    expect(
      pickPreferredTreeDropId(
        ["scratch", "child-a"],
        new Map([
          ["scratch", 8_000],
          ["child-a", 2_400],
        ]),
      ),
    ).toBe("child-a");
  });

  it("uses the root drop area only when no row contains the pointer", () => {
    expect(
      pickPreferredTreeDropId(
        [ROOT_DROP_AREA_ID],
        new Map([[ROOT_DROP_AREA_ID, 100_000]]),
      ),
    ).toBe(ROOT_DROP_AREA_ID);
  });

  it("returns null so closest-row fallback can run", () => {
    expect(pickPreferredTreeDropId([], new Map())).toBeNull();
  });
});
