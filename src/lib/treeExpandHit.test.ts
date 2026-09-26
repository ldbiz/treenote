import { describe, expect, it } from "vitest";
import { computeChevronBandX } from "./treeExpandHit";

describe("computeChevronBandX", () => {
  const rowLeft = 100;
  const indent = 24;

  it("includes the level padding gutter before the icon", () => {
    const { left, right } = computeChevronBandX(rowLeft, 2, indent, null);
    expect(left).toBe(rowLeft - 10);
    expect(right).toBe(rowLeft + indent + 24 + 10);
    expect(115).toBeGreaterThanOrEqual(left);
    expect(115).toBeLessThanOrEqual(right);
  });

  it("excludes the label region to the right of the band", () => {
    const { right } = computeChevronBandX(rowLeft, 2, indent, null);
    expect(160).toBeGreaterThan(right);
  });

  it("uses the measured icon right edge when provided", () => {
    const iconRight = rowLeft + indent + 24;
    const { right } = computeChevronBandX(rowLeft, 2, indent, iconRight);
    expect(right).toBe(iconRight + 10);
  });

  it("covers level-1 branch chevron column only", () => {
    const { left, right } = computeChevronBandX(rowLeft, 1, indent, null);
    expect(110).toBeGreaterThanOrEqual(left);
    expect(110).toBeLessThanOrEqual(right);
    expect(145).toBeGreaterThan(right);
  });
});
