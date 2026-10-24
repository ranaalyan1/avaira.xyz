/**
 * `?redirect=` handling — the login page forwards this value to the OAuth
 * start URL, so an unchecked value is an open redirect. Only same-origin
 * absolute paths are allowed through.
 */
import { PALETTE_ITEMS, PAGE_META, safeInternalPath } from "./navigation";

describe("safeInternalPath", () => {
  it("keeps internal paths, including a query", () => {
    expect(safeInternalPath("/dashboard")).toBe("/dashboard");
    expect(safeInternalPath("/agents?status=frozen")).toBe("/agents?status=frozen");
  });

  it("falls back when the value is missing", () => {
    expect(safeInternalPath(null)).toBe("/dashboard");
    expect(safeInternalPath(undefined)).toBe("/dashboard");
    expect(safeInternalPath("")).toBe("/dashboard");
    expect(safeInternalPath(undefined, "/")).toBe("/");
  });

  it("rejects anything that could leave the origin", () => {
    for (const value of [
      "https://evil.example/steal",
      "//evil.example/steal",
      "/\\evil.example",
      "javascript:alert(1)",
      "dashboard",
    ]) {
      expect(safeInternalPath(value)).toBe("/dashboard");
    }
  });
});

describe("palette destinations", () => {
  it("gives every entry a label, a path and a description", () => {
    for (const item of PALETTE_ITEMS) {
      expect(item.path.startsWith("/")).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.meta.length).toBeGreaterThan(0);
      expect(typeof item.icon).toBeTruthy();
    }
  });

  it("has one entry per path", () => {
    const paths = PALETTE_ITEMS.map((item) => item.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("documents every console route in PAGE_META", () => {
    for (const item of PALETTE_ITEMS.filter((entry) => entry.group === "Console")) {
      expect(PAGE_META[item.path]).toBe(item.meta);
    }
  });
});
