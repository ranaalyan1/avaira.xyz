# Design system

AVAIRA ships **three surfaces with one token layer**:

| Surface | Routes | Look |
| :--- | :--- | :--- |
| Site | `/`, `/gate`, `/score`, `/evidence`, `/docs` | **Pixel** — pure black ground, dot-matrix display type, 11px tracked mono labels, 1px hard edges, one indigo accent |
| Auth | `/login`, `*` | **Pixel** chrome around a light panel, so the sign-in path belongs to the same system as the site |
| Console | `/dashboard`, `/agents`, `/executions`, `/underwriters`, `/freeze`, `/treasury`, `/reputation`, `/hardening-report`, `/sdk` | **Dark** — blueprint-tinted neutrals, dense data, same indigo accent |

The site is deliberately a *site*: five routes, one question each, and a nav that
reads as a map of the protocol. Nothing lives on a single endless scroll.

---

## 1. Where the tokens live

| File | Role |
| :--- | :--- |
| `src/index.css` | The console's source of truth. `:root` defines the dark console; `.theme-marketing` re-declares the same variables for the light scope. Also shadcn/ui's `--background`/`--primary`/… so Radix components inherit either theme. |
| `src/pixel.css` | The site's source of truth. `.px-site` declares the `--px-*` tokens, then the `.px-*` component layer follows (nav, page head, sections, cards, tables, traces, footer, login, 404). It also hardens the console shell (`border-radius: 0 !important` is scoped, type sizes are pinned). |
| `tailwind.config.js` | Maps every console token to a Tailwind colour as `rgb(var(--token) / <alpha-value>)`, which keeps opacity modifiers (`bg-avaira-card/70`, `border-avaira-primary/30`) working and makes a theme swap a matter of one CSS variable block. |
| `src/App.css` | The console component layer: `.cyber-card`, `.cyber-btn`, `.data-table`, `.app-*`, `.page-*`, `.execution-*`, `.status-dot`. No literal colours — tokens only. |
| `src/lib/palette.js` | The console values as JS constants for the places that cannot read CSS variables: Recharts fills, `<Cell>`, SVG props. Also `statusColor()`, `gradeColor()`, `CHART_COLORS`. |
| `src/components/marketing/pixel.jsx` | The site's primitives: `Glyph`, `PixelNav`, `PixelFooter`, `SectionIndex`, `PixelFrame`, `SpecRows`, `Marquee`, `PageHead`, `ConsoleActions`. |
| `src/lib/motion.js` | The only module that imports anime.js. |

Because the console variables are RGB channels, a console component written once
renders correctly in both console scopes. Nothing needs a `dark:` variant.

## 2. Palette

### The site (`--px-*`, inside `.px-site`)

| Token | Value | Used for |
| :--- | :--- | :--- |
| `--px-black` | `#000000` | Art bands, page-head grounds |
| `--px-bg` | `#05060A` | Page background |
| `--px-panel` | `#0B0D12` | Cards, slabs |
| `--px-raise` | `#111319` | Inset rows, code blocks |
| `--px-ink` | `#F5F6F8` | Display type, values |
| `--px-dim` | `#9AA1AE` | Body copy |
| `--px-mute` | `#5E6674` | Metadata, footer labels |
| `--px-accent` | `#6E6BF2` | Primary action, index numbers |
| `--px-hi` | `#C9C7FF` | The one highlight — permit seals, lit pixels |
| `--px-red` | `#F45B69` | Refused intents, slashed collateral |
| `--px-line` | `rgba(255,255,255,0.14)` | 1px containment everywhere |
| `--px-line-2` | `rgba(255,255,255,0.30)` | Buttons and dividers that need to read as edges |

There is **no radius on the site**: `border-radius: 0 !important` inside `.px-site`,
and no shadow, glow or blur. Containment is one hard line. Grids are built as
`gap: 1px` over a `--px-line` background so the lines *are* the spacing.

### The console (unchanged)

| Token | Dark console | Light scope | Used for |
| :--- | :--- | :--- | :--- |
| `--surface-app` | `#08090C` | `#FFFFFF` | Page background |
| `--surface-card` | `#101218` | `#FFFFFF` | Cards, panels |
| `--surface-raised` | `#161920` | `#FAFAFB` | Inset bars, table headers |
| `--text-primary` | `#ECEFF4` | `#16181D` | Headings, values |
| `--text-secondary` | `#A8B0BF` | `#5B6068` | Body copy |
| `--text-muted` | `#6F7987` | `#858B94` | Labels, metadata |
| `--accent` | `#6E6BF2` | `#5B5BD6` | Primary actions, links, focus |
| `--violet` | `#9A6BFF` | `#7C5CF0` | Secondary data series |
| `--success` | `#34D399` | `#16A34A` | Settled, active, healthy |
| `--warning` | `#F5B544` | `#B47B04` | Pending, review, paused |
| `--danger` | `#F45B69` | `#D62D3C` | Frozen, slashed, blocked |
| `--info` | `#60A5FA` | `#2563EB` | Neutral telemetry series |
| `--hairline` | `#22252E` | `#E8E9EC` | 1px containment |

**Red is reserved for danger.** Scoring, navigation, primary buttons and links use
the indigo accent; `--danger`/`--px-red` means an agent was frozen, collateral was
slashed, or an intent was refused.

## 3. Typography

- **Doto** (self-hosted, `@fontsource/doto`) — every display heading on the site.
  Weight 900, uppercase, `line-height: 0.9`–`0.95`. The dot matrix is the design:
  it is never letter-spaced apart and never set small.
- **IBM Plex Mono** (self-hosted) — 11px tracked-out uppercase labels (`.px-label`,
  section indexes, table headers), 12–13px for data rows, traces and code.
  Mono means *machine text*: addresses, hashes, amounts, codes, figures.
- **Inter** — body prose only, 15–17px. Site headings are never Inter.
- Sentence case for prose; uppercase is reserved for display type and mono labels.

## 4. Rules for new UI

1. **Never write a hex value in a component.** Console components use a Tailwind
   token class or `palette.js`; site components use the `--px-*` variables. Only
   `lib/palette.js`, `src/pixel.css`, `src/index.css` and the static pre-render in
   `public/index.html` carry hex.
2. **A page, not a section.** The marketing site is five routes. New content gets a
   page (`src/pages/*Page.js`) registered in `App.js`, added to the nav and footer,
   and to the `PAGES` table in the smoke test. Do not append another band to home.
3. **Cards** are `.px-card` on the site (1px `--px-line`, panel ground, art plate on
   a black band) and `.cyber-card` in the console. Pointer tilt is allowed on site
   hero art through `usePointerTilt` — never on a table.
4. **Buttons** are `.px-btn` (with `.px-btn-accent`) on the site and `.cyber-btn` in
   the console. Hover swaps fill or border; nothing lifts, nothing glows.
5. **Tables** are `.px-table` (site) or `.data-table` (console): mono micro-label
   headers, 1px hairline rows, right-aligned numbers.
6. **Keep the interaction hooks and the section ids.** Every interactive element
   keeps its `data-testid`, and the ids the site has always exposed stay addressable —
   home `#pillars`/`#faq`, gate `#execution`/`#moats`, score `#revenue`/`#penalty`,
   evidence/docs `#top`, docs `#sdk`. The footer deep-links into all of them, so an
   old link still lands on the section that answers it. `design.smoke.test.js` fails
   if a hook, an id or a deep link disappears.
7. **Respect reduced motion.** Motion is opt-in and lives in the layer described in
   §8: under `prefers-reduced-motion` nothing is created and the stylesheet's default
   state — the resolved one — is what the visitor sees.
8. **No emoji or symbol glyphs.** Arrows, checkmarks, squares and keyboard glyphs do
   not stand in for an icon or a sentence: use `lucide-react` or write the word.
   `design.smoke.test.js` fails on a glyph in the rendered page markup.

## 5. Art direction

The site carries **pixel plates** in `public/art/` (png, 6–15 kB each). They are
rendered objects from the protocol's own world at machine resolution — dithered,
hard-edged, on black:

| Asset | Where it lands |
| --- | --- |
| `hero.png` | the home page head — a corridor of four gates with a lit card between them |
| `score.png` | the Rate pillar and the score page head |
| `underwrite.png` | the Clear pillar and the evidence band |
| `network.png` | the Insure pillar and the docs page head |
| `permit.png` · `refuse.png` | the two traces on `/gate` — a signed permit, a barrier across the corridor |
| `burn.png` · `ledger.png` | the penalty ladder and the fee streams on `/score` |

Rules that keep them coherent:

1. **Palette lock.** Black, indigo `#6E6BF2`, pale violet `#C9C7FF`, dithering for
   the in-between tones. A plate that introduces another hue is regenerated.
2. **Recipe.** Chunky pixel grid, no anti-aliasing, no text, no logos, no UI chrome.
   Generated large, reduced to a small grid and upscaled with nearest-neighbour so
   the pixels are real. Processed with ImageMagick only (`-filter point`, `-strip`);
   sources and intermediates are deleted, and png is the only committed artifact.
3. **Describe every plate.** Each `<img>` carries a written alt text saying what was
   rendered — never the mood, never empty.
4. **Leave room for type.** Plates sit in their own black band, or as a full-bleed
   `PageHead` ground with a top-down veil. Type never lands on a busy area.
5. **No pricing surfaces.** Tiers, per-check charges and revenue projections are not
   part of this system: the site states mechanism and measured figures only, and
   `design.smoke.test.js` fails on a `$` figure, the word "pricing" or a `#pricing`
   anchor in the rendered pages.

## 6. Adding a site page

```jsx
import { PageHead, PixelNav, PixelFooter, SectionIndex } from "@/components/marketing/pixel";

<div className="px-site" data-testid="thing-page">
  <PixelNav />
  <main id="content">
    <PageHead
      n="06"
      section="Thing"
      title="One line of display type."
      lede="A paragraph that says what this page answers."
      art="/art/ledger.png"
      artAlt="A pixel ledger stack, settled pages stacked on black"
      meta={["Label", "/", "Label"]}
    />
    <section className="px-section" id="thing">
      <SectionIndex n="06" label="Thing" />
      …
    </section>
  </main>
  <PixelFooter />
</div>
```

Then register the route in `src/App.js`, add it to the nav and the footer columns in
`components/marketing/pixel.jsx`, extend the static pre-render in `public/index.html`,
and add its entry to `PAGES` in `src/pages/design.smoke.test.js` (ids, copy, pixel
scope, art alts).

Console pages need no wrapper — the default `:root` scope is the dark console.

## 7. Pre-rendered site HTML

`public/index.html` carries a static pre-render of the whole site for crawlers and
no-JS visitors: nav, hero, the four-fact strip, pillars, the gate sequence, the
refusal codes, the score weights and bands, the evidence figures, the integration
snippet, the FAQ and the footer. Its inline `<style>` block (`.px-static`, prefixed
to avoid any collision with the app) mirrors the `--px-*` tokens, so the first paint
matches the hydrated React page.

**If the pixel tokens or the site copy change, update that block too** — it is the one
place the shell is written twice, and it is called out here so it does not rot.

## 8. Motion

`src/lib/motion.js` is the only module that imports anime.js (4.x) and the only
place animations are created.

| Hook | Use |
| --- | --- |
| `useReveal` | Each `[data-reveal]` target animates in once as it scrolls into view; targets arriving together are staggered. |
| `useCountUp` | A figure counts up when it enters the viewport; returns `[ref, display]`. |
| `usePointerTilt` | Damped `rotateX`/`rotateY` follow on hero art. Fine pointers only. |
| `useScrubTimeline` | An anime timeline linked to scroll position (`sync: true`), with `onProgress(0–1)` reporting progress so React state can follow without driving the animation. |
| `useEnterAnimation` | A scoped animation that plays once the element is in view. |

Rules that keep this honest:

1. **Effects only.** No window access at module scope, refs guarded, no animation
   during render.
2. **Static markup carries the finished state.** `renderToStaticMarkup` never runs
   effects, and neither does a crawler or a no-JS visitor: every number, corridor
   stage and marker renders its resolved value in the markup.
3. **Reduced motion means no animation at all**, not a faster one. The CSS default
   for every animated element is its resolved geometry.
4. **Scrubbed sections stay rare.** `/gate` carries the corridor; the rest of the site
   uses entrance reveals and count-ups, and every table and trace stays a document.
   The console keeps its motion to entrance reveals and count-ups so dense data
   surfaces hold still.

## 9. Verification

```bash
cd frontend
npm ci                      # frontend/.npmrc pins legacy-peer-deps (React 19 vs Radix/CSV peers)
CI=false npm run build      # CI=false: CRA promotes lint warnings to errors otherwise
npx craco test --watchAll=false
```

`design.smoke.test.js` covers the design contract: the site's per-page test IDs,
section ids and deep links, the pixel scope, the art plates and their alts, the
console shell hooks, the gate artefacts (four planes, both corridors, both traces,
the refusal enum, the score and penalty blocks), the absence of emoji and symbol
glyphs, the resolved value of every animated figure, the absence of any pricing
surface, and the palette mappings (including both Avaira Score ladders, `A+…D` from
`core/reputation.py` and `AAA…CCC` from the registry UI).

CI installs the frontend with `yarn install --frozen-lockfile`; the Vercel deploy uses
`npm ci`. Both lockfiles are tracked, so a dependency change has to update
`package.json`, `package-lock.json` and `yarn.lock` together.

Screenshots under `verification/*.png` are produced by `verify_frontend_v2.py` and
`verification/verify_v2_*.py` through Playwright against a running dev server; re-run
them after a visual change (they are not regenerated by CI).
