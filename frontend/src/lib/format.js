/**
 * Formatting helpers for values that come back from the API.
 *
 * The console renders every field the backend returns, and the backend is not
 * guaranteed to return all of them: an older agent document has no
 * `collateral_remaining`, a treasury row can miss `total_fee`, a mission can
 * arrive without `risk_level`. Calling `.toFixed()` (or `.toUpperCase()`) on
 * `undefined` throws inside render, which unmounts the whole route and leaves
 * an empty page — the failure looks like "the console is down" rather than
 * "one field is missing".
 *
 * These helpers always return a string, so a missing value degrades to the
 * placeholder instead of a blank screen.
 */

/** Parse a number out of number/string input. Returns null when it is not one. */
export const toNumber = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** Fixed-point number, or the placeholder when the value is absent/invalid. */
export const num = (value, decimals = 2, fallback = "—") => {
  const parsed = toNumber(value);
  return parsed === null ? fallback : parsed.toFixed(decimals);
};

/** Integer with thousands separators. */
export const int = (value, fallback = "—") => {
  const parsed = toNumber(value);
  return parsed === null ? fallback : Math.round(parsed).toLocaleString("en-US");
};

/** `$12.34` — the console's money idiom. */
export const usd = (value, decimals = 2, fallback = "—") => {
  const formatted = num(value, decimals, fallback);
  return formatted === fallback ? fallback : `$${formatted}`;
};

/** Any printable value, or the placeholder for null / undefined / "". */
export const text = (value, fallback = "—") =>
  value === null || value === undefined || value === "" ? fallback : String(value);

/** Locale time for a timestamp; an unparseable value renders the placeholder. */
export const timeLabel = (value, fallback = "—") => {
  if (value === null || value === undefined || value === "") return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleTimeString();
};

/** Locale date (and time when `withTime`) for a timestamp. */
export const dateLabel = (value, { withTime = false, fallback = "—" } = {}) => {
  if (value === null || value === undefined || value === "") return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return withTime ? date.toLocaleString() : date.toLocaleDateString();
};

/** `0x1234…abcd` — safe on short, missing and non-string values. */
export const shortAddress = (value, head = 6, tail = 4, fallback = "") => {
  if (typeof value !== "string" || value.length === 0) return fallback;
  if (value.length <= head + tail + 1) return value;
  if (tail <= 0) return `${value.slice(0, head)}…`;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
};
