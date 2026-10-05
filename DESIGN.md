# oai-codex serve — Design system

## 0. Research Log

- Embedded references: shortlisted Linear, Supabase, Warp; selected `minimalist-skill.md` and `linear.app.md`. Linear supplies compact dark surfaces and code typography; the minimalist reference supplies native typography, calm spacing and restrained controls. The operational brief takes precedence over either reference's marketing composition. The router's initial taste reference explicitly excludes dashboards, so it was replaced before implementation.
- Lazyweb: 2 queries, 2 screens viewed (Postman and Retool). Findings: compact method/endpoint/action row, stable request controls beside output, fine separators, short actionable empty states. Evidence is recorded in `docs/design-research/lazyweb-api-console-notes.md`.
- Imagen drafts: `docs/design-research/concepts.png` contains two generated directions. Selected A, the balanced workbench, as the spatial reference. Deliberate corrections: generated avatar, fake model/version, connected state and token-like content are removed. Real runtime fields determine all product status. No raster screenshot is shipped as UI.
- Palette sanity check: ui-ux-db query `developer dashboard dark accessibility monospace` confirmed dark developer surfaces, readable metadata and distinct semantic success treatment; Linear's neutral palette remains the source.
- Interaction source: beui.dev `action-swap/raw` attempted with curl; returned no content in this restricted network. Native button feedback and reduced-motion CSS are used; no source-backed claim is made.
- React tooling gate: not applicable; vanilla TypeScript DOM application.

## 1. Atmosphere & Identity

A focused local control room for running and understanding API requests. The signature is a balanced workbench: the input remains beside the live output, with an inset monospace event console underneath. Near-black chrome, shallow luminance steps and a restrained violet action accent express precision. This is an operational product, without marketing heroes, decorative charts or invented counters.

Primary user: a developer testing the gateway locally or on their own Tailscale network. Secondary constraints: keyboard operation, mobile observation, variable network latency, cognitive load. Primary path: connect → select model → send request → inspect output/events → reproduce with cURL. Navigation and request controls stay predictable.

Content jobs: sidebar navigates; connection status orients; request editor enables action; response proves the result; activity helps diagnose; configuration explains the running server; documentation links to the actual contract.

## 2. Color

One dark theme. Semantic colors appear only for actual state; every state also has a text label.

| Token | Value | Use |
|---|---|---|
| `--canvas` | `#08090a` | Main canvas |
| `--panel` | `#0f1011` | Navigation and panel |
| `--raised` | `#191a1b` | Controls, elevated rows |
| `--hover` | `#232429` | Interactive hover |
| `--text` | `#f7f8f8` | Primary text |
| `--muted` | `#a1a6af` | Secondary labels |
| `--faint` | `#777d87` | Disabled and decorative text |
| `--line` | `#2c2f35` | Controls and separators |
| `--line-soft` | `#202227` | Quiet dividers |
| `--accent` | `#b2afff` | Primary action and focus |
| `--accent-hover` | `#c9c7ff` | Action hover |
| `--accent-ink` | `#18152d` | Text on action |
| `--accent-soft` | `#24223c` | Selected navigation |
| `--success` | `#75dba6` | Confirmed success |
| `--warning` | `#e8c17c` | Unsupported/unverified warning |
| `--danger` | `#ff9d9d` | Error/cancel action |
| `--scrim` | `rgb(0 0 0 / 0.7)` | Modal backdrop |

## 3. Typography

Native sans: `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Mono: `"SFMono-Regular", Consolas, "Liberation Mono", monospace`. No downloaded fonts or third-party font request. Linear's proprietary typefaces are inspiration, not assets.

| Token | Size | Weight | Leading | Use |
|---|---|---|---|---|
| `--text-xs` | 12px | 400/600 | 1.5 | Metadata and code |
| `--text-sm` | 14px | 400/500 | 1.5 | Controls, body |
| `--text-md` | 16px | 400/600 | 1.5 | Panel titles |
| `--text-lg` | 20px | 600 | 1.3 | Metrics |
| `--text-xl` | 28px | 600 | 1.2 | Page title, tracking -0.03em |

Prose stays under 70ch. Code wraps unbroken strings or scrolls inside its named pane.

## 4. Spacing & Layout

Spacing tokens: `--s1:4px`, `--s2:8px`, `--s3:12px`, `--s4:16px`, `--s5:20px`, `--s6:24px`, `--s8:32px`, `--s10:40px`, `--s12:48px`.
Geometry tokens: sidebar 216px; control minimum height 40px desktop/44px touch; radii 4px / 6px / 10px; content maximum 1600px; code minimum height 220px; page gutters 32px desktop / 20px tablet / 16px mobile. Content geometry: instructions 84px, raw editor 320px, output pane 372px, config editor 420px, login 500px, topbar 64px, route-method column 100px, explorer rail floor 220px and compact rail maximum 260px. These bounded sizes preserve predictable scroll ownership.

Shell: bounded `100dvh` grid, fixed sidebar plus `minmax(0,1fr)` main. Main owns vertical page scroll; code output and event log own bounded local overflow because their length is unbounded. Every shrinking grid child has `min-width:0; min-height:0`. Headers are normal shell rows, not nested sticky layers.

At 1024px the workbench stacks; below 768px sidebar becomes a compact top navigation reel and labels remain visible. At 390px controls wrap, metrics use two columns, code never expands the viewport. Tables gain local overflow with keyboard reachability. The primary page never requires two-dimensional scrolling.

## 5. Components

- **Button**: native button or navigation anchor; primary, secondary, ghost, danger; 8/12px padding and 6px radius; hover, press, visible focus, disabled and busy text. No icon-only primary actions.
- **Field**: label + native input/select/textarea + hint; default, focus, invalid, disabled. Label is explicitly associated. Password field uses session-only gateway token, never upstream credentials.
- **Panel**: section + header + body + optional toolbar; 10px radius, 1px border, panel surface, 16/20px padding. Code body uses inset canvas. Empty/error/loading content belongs inside the panel it describes.
- **Badge**: inline label, neutral/success/warning/danger; text and color jointly convey state. Runtime badges never imply a test has passed.
- **Tabs**: native buttons with `aria-pressed`, switching visible text, events or JSON; selected underline and accent text. Focus stays on the triggering control.
- **Notice**: paragraph with status or alert role, always adjacent to the relevant action; text preserves error detail without HTML interpretation.
- **Key-value rows**: two-column definition list; stacked on narrow screens; endpoint strings wrap.
- **Request console**: form and result panel; explicit send/cancel state; models loaded live; raw JSON always available; result is never cleared by switching display tab.
- **Optional instructions disclosure**: native details/summary keeps the primary send action visible at desktop heights. Prompt editor uses a 180px minimum; optional instructions expand on demand.
- **Primitive showcase**: `#showcase` exposes the actual shared components with default/focus/disabled/loading/error/empty samples for visual review before product composition.

## 6. Motion & Interaction

`--motion-fast:120ms`; ease-out; transform/opacity only. Button press translates by 1px, immediate input feedback, tab state changes without layout animation. Copy button changes label to “Copié” then restores. Streaming text is incremental without character animation. No continuous decorative motion. `prefers-reduced-motion:reduce` removes transitions and transforms. Cancellation stays available while streaming.

## 7. Depth & Surface

Mixed luminance and borders: canvas → panel → raised control. A 1px quiet inset highlight is allowed on primary controls, no card shadows. The result and event panes recess into the canvas to create hierarchy. No gradients or glossy material on this operational surface.

## 8. Accessibility Constraints & Accepted Debt

WCAG 2.2 AA target: 4.5:1 small text; 3:1 interface boundaries/focus; native keyboard controls; 44px touch targets; no color-only status. Skip link targets the main region. Errors use `role=alert`; request lifecycle uses a concise live status rather than reading every streamed token. Content stress includes empty lists, long paths and invalid JSON. Secrets are never included in copied cURL; it uses `$OAI_CODEX_TOKEN`.

No user-accepted design debt. Missing browser or Lighthouse evidence must be reported as unverified, never a pass. Generated mockup text is not authoritative. Configuration editing is limited to backend-supported fields; unavailable settings remain explicitly informational.

## Tests API — guided workbench

Primary path: Tests API → Responses → numbered scenario → configure → run → read two verdicts → explicitly continue. The existing Playground navigation is replaced; Explorer remains the free-form console. Keep one scenario visible at a time. Other API groups are ordered Images, Audio, Realtime, Live and clearly marked as future guided coverage, with Explorer access.

Reuse all existing color, spacing, field, button, panel, badge, notice and native details primitives. Scenario rail uses the existing explorer rail floor/maximum; request and result stack within the remaining space. At tablet/mobile the rail becomes a collapsed native disclosure before the scenario. No new palette or motion. One primary run action, adjacent stop action only while running. Global metrics are hidden on Tests API to keep the scenario above the fold.

States: Non testé, En cours, Réussi, Échec, Bloqué. Technical completion and behavioral check are separate labeled verdicts; manual judgments remain Non vérifié until a user evaluates them. Pending/blocked capability is never success. Input edits invalidate the displayed result. Navigating within the workbench preserves drafts and results; leaving the page aborts active requests and clears in-memory prompts/results. The UI explicitly describes this lifetime. No prompt persistence is introduced.

Evidence disclosure: exact browser request, proxy adaptation explanation labeled as configuration-derived (not captured upstream traffic), received events and raw response, HTTP status/duration/first-text latency. No auth headers. Long content wraps/scrolls locally; loading and errors use a concise live region, not streaming token announcements. Keyboard focus moves to the scenario heading on explicit step navigation. Blocked lifecycle tests explain the missing prerequisite and link to the Explorer without claiming backend incompatibility.
