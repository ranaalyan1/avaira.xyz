/**
 * Formatting helpers — the console's defence against a partial API document.
 *
 * Each case here is a shape the backend can actually return: a field the
 * aggregation skipped (`undefined`), an explicit `null`, a numeric string from
 * a Mongo projection, or garbage. None of them may throw inside render.
 */
import { dateLabel, int, num, shortAddress, text, timeLabel, toNumber, usd } from "./format";

describe("toNumber", () => {
  it("accepts numbers and numeric strings", () => {
    expect(toNumber(12.5)).toBe(12.5);
    expect(toNumber("12.5")).toBe(12.5);
    expect(toNumber(0)).toBe(0);
    expect(toNumber("-3")).toBe(-3);
  });

  it("rejects everything that is not a finite number", () => {
    for (const value of [undefined, null, "", "  ", "abc", NaN, Infinity, {}, []]) {
      expect(toNumber(value)).toBeNull();
    }
  });
});

describe("num", () => {
  it("formats to a fixed number of decimals", () => {
    expect(num(12.3456, 2)).toBe("12.35");
    expect(num("7", 4)).toBe("7.0000");
    expect(num(0, 0)).toBe("0");
  });

  it("returns the placeholder instead of throwing on a missing field", () => {
    expect(num(undefined, 2)).toBe("—");
    expect(num(null, 6)).toBe("—");
    expect(num("n/a")).toBe("—");
    expect(num(undefined, 2, "0.00")).toBe("0.00");
  });
});

describe("int and usd", () => {
  it("groups integers and never prints NaN", () => {
    expect(int(1234)).toBe("1,234");
    expect(int("42")).toBe("42");
    expect(int(undefined)).toBe("—");
  });

  it("prefixes money only when there is a number", () => {
    expect(usd(3.5)).toBe("$3.50");
    expect(usd(undefined)).toBe("—");
  });
});

describe("text", () => {
  it("stringifies values and falls back for empty ones", () => {
    expect(text("orion-11")).toBe("orion-11");
    expect(text(0)).toBe("0");
    expect(text(undefined)).toBe("—");
    expect(text(null, "unknown")).toBe("unknown");
    expect(text("", "unknown")).toBe("unknown");
  });
});

describe("date and time labels", () => {
  it("renders real timestamps", () => {
    const iso = "2026-10-24T12:34:56.000Z";
    expect(timeLabel(iso)).not.toBe("—");
    expect(dateLabel(iso)).not.toBe("—");
    expect(dateLabel(iso, { withTime: true })).not.toBe("—");
  });

  it("does not print Invalid Date", () => {
    expect(timeLabel(undefined)).toBe("—");
    expect(timeLabel("not-a-date")).toBe("—");
    expect(dateLabel(null)).toBe("—");
    expect(dateLabel("")).toBe("—");
  });
});

describe("shortAddress", () => {
  it("truncates the middle and keeps the ends", () => {
    expect(shortAddress("0xBAd4cb2Ec6667674b2B61B1d4C8FFfbF7FE64040")).toBe("0xBAd4…4040");
  });

  it("leaves short values alone", () => {
    expect(shortAddress("0x1234")).toBe("0x1234");
  });

  it("handles a zero-length tail without duplicating the value", () => {
    expect(shortAddress("0x1234567890", 6, 0)).toBe("0x1234…");
  });

  it("returns the fallback for non-strings", () => {
    expect(shortAddress(undefined, 6, 4, "—")).toBe("—");
  });
});
