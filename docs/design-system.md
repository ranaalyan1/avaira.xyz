# Design system

AVAIRA ships **two surfaces with one component layer**:

| Surface | Routes | Theme |
| :--- | :--- | :--- |
| Marketing | `/`, `/login`, 404 | **Light** — white canvas, hairline dividers, indigo accent, pastel glows |
| Console | `/dashboard`, `/agents`, `/executions`, `/underwriters`, `/freeze`, `/treasury`, `/reputation`, `/hardening-report`, `/sdk` | **Dark** — blueprint-tinted neutrals, dense data, same indigo accent |

This mirrors how developer tools separate the two: a light, calm marketing site
that sells the product, and a dark operator console that runs it.

---

## 1. Where the tokens live

| File | Role |
| :--- | :--- |
| `src/index.css` | The single source of truth. `:root` defines the dark console; `.theme-marketing` re-declares the same variables for the light scope. Also shadcn/ui's `--background`/`--primary`/… so Radix components inherit either theme. |
| `tailwind.config.js` | Maps every token to a Tailwind colour as `rgb(var(--token) / <alpha-value>)`, which keeps opacity modifiers (`bg-avaira-card/70`, `border-avaira-primary/30`) working and makes a theme swap a matter of one CSS variable block. |
| `src/App.css` | The shared component layer: `.cyber-card`, `.cyber-btn`, `.data-table`, `.app-*`, `.page-*`, `.execution-*`, `.status-dot`, plus the `.mk-*` marketing utilities. No literal colours — tokens only. |
| `src/lib/palette.js` | The same values as JS constants for the places that cannot read CSS variables: Recharts fills, `<Cell>`, SVG props. Also `statusColor()`, `gradeColor()`, `CHART_COLORS`. |

Because the variables are RGB channels, a component written once renders
correctly in both scopes. Nothing needs a `dark:` variant.

## 2. Palette

| Token | Dark console | Light marketing | Used for |
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
the indigo accent; `avaira-red`/`--danger` means an agent was frozen, collateral
was slashed, or an intent was blocked.

## 3. Typography

- **Inter** — headings and body, everywhere. Headings are `font-semibold` with
  tight tracking (`-0.02em`…`-0.035em`); marketing display type goes to `-0.035em`.
- **JetBrains Mono** — machine data only: addresses, hashes, amounts, table
  columns of numbers, uppercase micro-labels.
- Sentence case. The previous system shouted in uppercase Rajdhani; only mono
  micro-labels (nav group headings, table headers) stay uppercase, and they are
  small and tracked out.

## 4. Rules for new UI

1. **Never write a hex value in a component.** Use a Tailwind token class or
   `palette.js`. `grep -rn "#[0-9A-Fa-f]\{6\}" src --include=*.js` should only
   match `lib/palette.js`, the dark mock frames in `components/marketing/`, and
   third-party brand marks (the Google logo on the sign-in page).
2. **Cards** are `.cyber-card` (console) or `.mk-card` (marketing): 1px hairline,
   `--radius` corners, shadow from `--shadow-panel`. No glow. Pointer tilt is
   allowed on marketing hero art through `usePointerTilt`, described in §8 — not
   on console surfaces and never on a table.
3. **Buttons** are `.cyber-btn` (console) or `.mk-btn.mk-btn-primary` /
   `.mk-btn-secondary` (marketing).
4. **Tables** use `.data-table`: mono micro-label headers, hairline rows, right
   aligned numbers.
5. **Marketing sections** use `.mk-container` + `.mk-section` so the hairline
   rhythm and vertical spacing stay consistent; the pastel glows are `.mk-glow`
   blobs placed behind content, never gradients on text.
6. **Keep the interaction hooks.** Every interactive element keeps its
   `data-testid`; `src/pages/design.smoke.test.js` renders the pages to static
   markup and fails if a documented hook or section anchor disappears.
7. **Respect reduced motion.** Motion is opt-in and lives in the layer described
   in §8: under `prefers-reduced-motion` nothing is created and the stylesheet's
   default state — the resolved one — is what the visitor sees.

8. **No emoji or symbol glyphs.** Arrows, checkmarks and keyboard glyphs do not
   stand in for an icon or a sentence: use `lucide-react` or write the word.
   `design.smoke.test.js` fails on a glyph in the rendered landing markup.

## 5. Art direction

The landing page carries rendered frames in `public/art/` (webp, ~276 kB for
the set). They are objects from the protocol's own world — glass, metal, light —
not UI screenshots and not stock:

| Asset | Where it lands |
| --- | --- |
| `hero-gate.webp` | the hero frame, copy over its dark half |
| `gate-3d.webp` · `score-3d.webp` · `underwrite-3d.webp` | the three pillar tiles |
| `decision-3d.webp` | the decision band, before the refusal list |
| `underwriter-network.webp` | the underwriting band, carrying the fee streams |

Rules that keep them coherent:

1. **Palette lock.** Near-black `#08090C`, indigo `#6E6BF2`, violet `#9A6BFF`,
   neutral glass and metal. A frame that introduces another hue is regenerated.
2. **Leave room for type.** The hero and the first band are copy-left, the
   closing band is copy-right; the veil gradient belongs to the component, not
   the render.
3. **Describe every frame.** Each `<img>` carries a written alt text saying what
   the object is.
4. **No pricing surfaces.** Tiers, per-check charges and revenue projections are
   not part of this system: the marketing page states mechanism and measured
   figures only, and `design.smoke.test.js` fails on a `$` figure or a
   `#pricing` anchor in the rendered page.

### The image scope

Sections that sit on a frame (`.hero`, `.band`) re-declare the type tokens for a
dark ground — `--text-primary: 255 255 255`, `--text-secondary`, `--text-muted`,
a brighter `--accent`, `--hairline-art`. That is the third scope alongside the
dark console (`:root`) and the light marketing surface (`.theme-marketing`), and
it is why the same `.mk-` utilities work over a photograph without special cases.

## 6. Adding a marketing surface

Wrap the page root in `theme-marketing` and use `.mk-*` utilities:

```jsx
<div className="theme-marketing min-h-screen bg-avaira-bg text-foreground" data-testid="…">
  <div className="mk-container mk-section">…</div>
</div>
```

Console pages need no wrapper — the default `:root` scope is the dark console.

## 7. Pre-rendered marketing HTML

`public/index.html` carries a static pre-render of the landing page for crawlers
and no-JS visitors. Its inline `<style>` block mirrors the light tokens above, so
the first paint matches the hydrated React page. **If the light tokens change,
update that block too** — it is the one place the palette is duplicated, and it is
called out here so it does not rot.

## 8. Verification

```bash
cd frontend
npm ci                      # frontend/.npmrc pins legacy-peer-deps (React 19 vs Radix/CSV peers)
CI=false npm run build      # CI=false: CRA promotes lint warnings to errors otherwise
npx craco test --watchAll=false
```

`design.smoke.test.js` covers the design contract: marketing test IDs and
anchors, the console shell hooks, the gate artefacts (both corridors, both traces,
the refusal enum, the score and penalty blocks), the absence of emoji and symbol
glyphs, the resolved value of every animated figure, and the palette mappings
(including both Avaira Score ladders, `A+…D` from `core/reputation.py` and
`AAA…CCC` from the registry UI).

CI installs the frontend with `yarn install --frozen-lockfile`; the Vercel deploy
uses `npm ci`. Both lockfiles are tracked, so a dependency change has to update
`package.json`, `package-lock.json` and `yarn.lock` together.

Screenshots under `verification/*.png` are produced by `verify_frontend_v2.py`
and `verification/verify_v2_*.py` through Playwright against a running dev
server; re-run them after a visual change (they are not regenerated by CI).

## 9. Motion

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
4. **Scrubbed sections stay rare.** The landing page uses two corridors; the console
   keeps its motion to entrance reveals and count-ups so dense data surfaces hold
   still.
