import { describe, expect, it } from "vitest";
import { MIN_NODE, nodeTooOld } from "../../src/utils/node-version.js";

describe("nodeTooOld", () => {
  it("flags versions below the minimum", () => {
    expect(nodeTooOld("16.20.0")).toBe(true);
    expect(nodeTooOld("17.9.0")).toBe(true);
    expect(nodeTooOld("14.0.0")).toBe(true);
  });

  it("accepts the minimum and above", () => {
    expect(nodeTooOld(`${MIN_NODE[0]}.${MIN_NODE[1]}.0`)).toBe(false);
    expect(nodeTooOld("18.0.0")).toBe(false);
    expect(nodeTooOld("20.11.0")).toBe(false);
    expect(nodeTooOld("24.0.0")).toBe(false);
  });

  it("tolerates pre-release / partial strings", () => {
    expect(nodeTooOld("23.0.0-nightly")).toBe(false);
    expect(nodeTooOld("17")).toBe(true); // 17.0 < 18.0
    expect(nodeTooOld("not-a-version")).toBe(false); // unparseable → don't block
  });

  it("honors a custom minimum", () => {
    expect(nodeTooOld("22.0.0", [22, 13])).toBe(true);
    expect(nodeTooOld("22.13.0", [22, 13])).toBe(false);
  });
});
