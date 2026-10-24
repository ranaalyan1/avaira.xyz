/**
 * Command palette (⌘K / Ctrl-K).
 *
 * The sidebar used to advertise "Search · Cmd K" on a button that did nothing.
 * This is the control behind that hint: one dialog, keyboard-first, that jumps
 * to any console route or public page. It filters on label, path and the
 * one-line description, so "fee" finds Treasury and "score" finds both the
 * reputation view and the public score page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CornerDownLeft, Search } from "lucide-react";
import { PALETTE_ITEMS } from "@/lib/navigation";

const matches = (item, query) => {
  if (!query) return true;
  const haystack = `${item.label} ${item.path} ${item.meta}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
};

export default function CommandPalette({ open, onOpenChange }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const itemRefs = useRef([]);
  const restoreFocusRef = useRef(null);

  const results = useMemo(() => PALETTE_ITEMS.filter((item) => matches(item, query)), [query]);

  /* Reset the query each time the palette opens, and put the caret in the box. */
  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = typeof document !== "undefined" ? document.activeElement : null;
    setQuery("");
    setActive(0);
    const focus = window.requestAnimationFrame(() => inputRef.current?.focus());
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.cancelAnimationFrame(focus);
      document.body.style.overflow = previousOverflow;
      const restore = restoreFocusRef.current;
      if (restore && typeof restore.focus === "function") restore.focus();
    };
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  const select = useCallback(
    (item) => {
      if (!item) return;
      onOpenChange(false);
      navigate(item.path);
    },
    [navigate, onOpenChange],
  );

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (results.length ? (current + 1) % results.length : 0));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (results.length ? (current - 1 + results.length) % results.length : 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      select(results[active]);
    }
  };

  /* keep the highlighted row visible while arrowing through a long list */
  useEffect(() => {
    if (!open) return;
    const node = itemRefs.current[active];
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "nearest" });
    }
  }, [active, open]);

  if (!open) return null;

  let lastGroup = null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 p-4 pt-[12vh] backdrop-blur-sm"
      data-testid="command-palette"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-lg overflow-hidden rounded-xl border border-avaira-borderStrong bg-avaira-card shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-avaira-border px-3">
          <Search size={14} className="shrink-0 text-avaira-dim" aria-hidden="true" />
          <input
            ref={inputRef}
            data-testid="command-palette-input"
            aria-label="Search pages"
            aria-controls="command-palette-results"
            aria-activedescendant={results[active] ? `command-palette-item-${active}` : undefined}
            role="combobox"
            aria-expanded="true"
            autoComplete="off"
            spellCheck="false"
            placeholder="Jump to a page…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            className="h-11 w-full bg-transparent font-mono text-[13px] text-foreground outline-none placeholder:text-avaira-dim"
          />
          <kbd className="hidden rounded border border-avaira-border px-1.5 py-0.5 font-mono text-[10px] text-avaira-dim sm:block">
            ESC
          </kbd>
        </div>

        <ul
          id="command-palette-results"
          role="listbox"
          aria-label="Pages"
          className="max-h-80 overflow-y-auto p-1.5"
        >
          {results.length === 0 ? (
            <li className="px-3 py-6 text-center font-mono text-[11px] text-avaira-dim" role="presentation">
              No page matches “{query}”.
            </li>
          ) : (
            results.map((item, index) => {
              const showGroup = item.group !== lastGroup;
              lastGroup = item.group;
              const Icon = item.icon;
              return (
                <li key={item.path} role="presentation">
                  {showGroup ? (
                    <p className="px-2.5 pb-1 pt-2.5 font-mono text-[9px] uppercase tracking-[0.16em] text-avaira-dim">
                      {item.group}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    id={`command-palette-item-${index}`}
                    role="option"
                    aria-selected={index === active}
                    data-testid={`command-palette-${item.path === "/" ? "home" : item.path.slice(1)}`}
                    ref={(node) => {
                      itemRefs.current[index] = node;
                    }}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => select(item)}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                      index === active
                        ? "bg-avaira-primary/12 text-avaira-primary"
                        : "text-avaira-muted hover:bg-avaira-surface hover:text-foreground"
                    }`}
                  >
                    <Icon size={14} strokeWidth={1.9} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{item.label}</span>
                      <span className="block truncate font-mono text-[10px] text-avaira-dim">{item.meta}</span>
                    </span>
                    {index === active ? (
                      <CornerDownLeft size={12} className="shrink-0 opacity-70" aria-hidden="true" />
                    ) : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
