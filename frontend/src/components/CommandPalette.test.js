/**
 * Command palette — the control behind the sidebar's "Search · Ctrl K" hint.
 *
 * Rendered with the shared static-render world (marketing.mocks) so the test
 * asserts on markup the way a crawler and a keyboard user's first frame see it.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import "@/pages/marketing.mocks";
import CommandPalette from "./CommandPalette";
import { NAV_ITEMS, PUBLIC_ITEMS } from "@/lib/navigation";

const render = (open) =>
  renderToStaticMarkup(<CommandPalette open={open} onOpenChange={() => {}} />);

const testIdFor = (path) => (path === "/" ? "home" : path.slice(1));

describe("command palette", () => {
  it("renders nothing while closed", () => {
    expect(render(false)).toBe("");
  });

  it("is a labelled modal listbox when open", () => {
    const html = render(true);
    expect(html).toContain('data-testid="command-palette"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-label="Search pages"');
  });

  it("lists every console route", () => {
    const html = render(true);
    NAV_ITEMS.forEach((item) => {
      expect(html).toContain(`data-testid="command-palette-${testIdFor(item.path)}"`);
    });
  });

  it("can cross into the public pages", () => {
    const html = render(true);
    PUBLIC_ITEMS.forEach((item) => {
      expect(html).toContain(`data-testid="command-palette-${testIdFor(item.path)}"`);
    });
  });

  it("marks the first result as selected and carries the keyboard hint", () => {
    const html = render(true);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("ESC");
  });
});
