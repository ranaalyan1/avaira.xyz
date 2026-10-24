/**
 * Copy text to the clipboard without throwing.
 *
 * `navigator.clipboard` only exists in a secure context (https / localhost) and
 * the returned promise rejects when the document is not focused or the copy was
 * blocked. Several console views called `.writeText()` bare, so a blocked copy
 * produced an unhandled promise rejection *and* a "Copied" toast that was not
 * true. This helper reports whether the copy actually happened, and falls back
 * to the legacy `execCommand("copy")` path for plain-http deployments.
 */
export async function copyText(value) {
  const stringValue = value === null || value === undefined ? "" : String(value);
  if (!stringValue) return false;

  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : null;
  const secure = typeof window === "undefined" || window.isSecureContext !== false;
  if (clipboard && typeof clipboard.writeText === "function" && secure) {
    try {
      await clipboard.writeText(stringValue);
      return true;
    } catch {
      /* fall through to the legacy path */
    }
  }

  if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
  try {
    const area = document.createElement("textarea");
    area.value = stringValue;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = typeof document.execCommand === "function" && document.execCommand("copy");
    document.body.removeChild(area);
    return Boolean(copied);
  } catch {
    return false;
  }
}
