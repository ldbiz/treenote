import { describe, expect, it } from "vitest";
import {
  MAX_TREE_LEVEL,
  canAddChildAtLevel,
  nodeLevel,
  subtreeDepth,
  wouldExceedMaxLevel,
} from "./treeDepth";

const chain = Array.from({ length: 20 }, (_, index) => ({
  value: `n${index + 1}`,
  parentValue: index === 0 ? undefined : `n${index}`,
}));

const items = [
  ...chain,
  { value: "leaf" },
  { value: "branch", parentValue: "leaf" },
  { value: "branch-child", parentValue: "branch" },
  { value: "branch-leaf", parentValue: "branch-child" },
  { value: "over-root" },
  ...Array.from({ length: 21 }, (_, index) => ({
    value: `over${index + 1}`,
    parentValue: index === 0 ? "over-root" : `over${index}`,
  })),
];

describe("nodeLevel", () => {
  it("counts forest roots as level 1", () => {
    expect(nodeLevel(chain, "n1")).toBe(1);
    expect(nodeLevel(chain, "n10")).toBe(10);
    expect(nodeLevel(chain, "n20")).toBe(20);
  });
});

describe("subtreeDepth", () => {
  it("is 1 for a leaf and grows with descendants", () => {
    expect(subtreeDepth(items, "leaf")).toBe(4);
    expect(subtreeDepth(items, "branch-leaf")).toBe(1);
    expect(subtreeDepth(items, "n20")).toBe(1);
  });
});

describe("canAddChildAtLevel", () => {
  it("allows children below the cap and blocks level 20", () => {
    expect(canAddChildAtLevel(1)).toBe(true);
    expect(canAddChildAtLevel(19)).toBe(true);
    expect(canAddChildAtLevel(MAX_TREE_LEVEL)).toBe(false);
    expect(canAddChildAtLevel(0)).toBe(false);
  });
});

describe("wouldExceedMaxLevel", () => {
  it("allows moving a leaf under a level-19 node", () => {
    expect(wouldExceedMaxLevel(items, "branch-leaf", "n19")).toBe(false);
  });

  it("blocks moving a leaf under a level-20 node", () => {
    expect(wouldExceedMaxLevel(items, "branch-leaf", "n20")).toBe(true);
  });

  it("blocks moving a 3-deep branch under a level-18 node", () => {
    expect(wouldExceedMaxLevel(items, "branch", "n18")).toBe(true);
  });

  it("allows moving an already-over-cap branch to the forest root", () => {
    expect(wouldExceedMaxLevel(items, "over-root", null)).toBe(false);
  });

  it("blocks making a grandfathered deep branch even deeper", () => {
    expect(wouldExceedMaxLevel(items, "over-root", "n1")).toBe(true);
  });
});
