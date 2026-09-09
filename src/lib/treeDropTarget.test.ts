import { describe, expect, it } from "vitest";
import {
  BEFORE_DROP_PREFIX,
  ROOT_DROP_AREA_ID,
  beforeDropId,
  isBeforeDropId,
  nodeIdFromBeforeDropId,
} from "./treeDropTarget";

describe("treeDropTarget ids", () => {
  it("builds and parses before-drop ids", () => {
    const id = beforeDropId("node-1");
    expect(id).toBe(`${BEFORE_DROP_PREFIX}node-1`);
    expect(isBeforeDropId(id)).toBe(true);
    expect(nodeIdFromBeforeDropId(id)).toBe("node-1");
  });

  it("recognises the root drop area id", () => {
    expect(ROOT_DROP_AREA_ID).toBe("root-drop-area");
  });
});
