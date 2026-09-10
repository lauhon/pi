---
name: cosmos
description: Write HTML/CSS that follows the Red Bull Cosmos Design System foundation (primitives/tokens for color, typography, spacing, radius, border, elevation, breakpoints, backdrop blur). Use when building or styling web UI that must match Red Bull / Cosmos brand guidelines.
user-invocable: true
---

# Cosmos Foundation — Writing On-Brand HTML

Cosmos is Red Bull's design system (RBDS). This skill covers the **Foundation**: the
design **primitives** (tokens) you must use so markup matches brand guidelines. Tokens are
delivered as **CSS Custom Properties** named `--cosmos-*`.

> Reference docs (require Red Bull login): https://cosmos.redbull.design

## Golden Rules

1. **Never hardcode brand values.** Use `var(--cosmos-…)` for every color, spacing, radius,
   border width, shadow, font-family, and breakpoint. Raw hex/px for these is a guideline violation.
2. **Use color by role, not by look.** Pick the token whose *role* matches the purpose
   (primary, surface, text, accent-positive/negative/inform/focus) — don't pick a color because
   it "looks right".
3. **Type scale couples size + line-height + spacing.** When sizing text, use the matching
   `font-size` / `line-height` / `spacing-top` / `spacing-bottom` tokens together.
4. **Scale is multiples of 4.** Distances between elements and panel padding come from
   `--cosmos-spacing-*`.
5. Stay within the provided tokens. If something isn't covered, derive from existing tokens
   (e.g. `calc()` on a spacing token) rather than inventing values.

## Install / Load

### Quick (prototyping, plain HTML) — load from the static host
```html
<head>
  <!-- Primitives: defines all --cosmos-* CSS variables -->
  <link rel="stylesheet" href="https://rbds-static.redbull.com/@cosmos/foundation/latest/index.css">
  <!-- Fonts: Bull / Bull Text font-face declarations (Latin/Cyrillic/Greek) -->
  <link rel="stylesheet" href="https://rbds-static.redbull.com/@cosmos/foundation/latest/fonts/default.css">
</head>
```

### Production — npm package `@cosmos/foundation`
Cosmos ships from Red Bull's in-house registry, so scope `@cosmos` first.

`.npmrc`:
```
@cosmos:registry=https://artifactory.redbullmediahouse.com/artifactory/api/npm/rbds-npm-local/
```
`.yarnrc.yml` (yarn 4+):
```yaml
npmScopes:
  cosmos:
    npmRegistryServer: "https://artifactory.redbullmediahouse.com/artifactory/api/npm/rbds-npm-local/"
```
Then:
```bash
npm install --save-dev @cosmos/foundation
# or: yarn add @cosmos/foundation --dev
```
Import the primitives (CSS, also available as SCSS/LESS/Stylus):
```css
@import url('./node_modules/@cosmos/foundation/lib/primitives/index.css');

input { border-radius: var(--cosmos-radius-large); }
```

### Fonts for other scripts
`default.css` covers Latin/Cyrillic/Greek. For other languages, load the matching file
instead of/in addition to `default.css`: `ar.css` (Arabic), `hi.css` (Hindi), `ja.css`
(Japanese), `ko.css` (Korean), `th.css` (Thai), `he.css` (Hebrew), `ka.css` (Georgian).

## Color

Use the role that matches intent. Each color has `-darker` / `-lighter` and/or opacity variants.

### Primary — brand red, use sparingly for key highlights
| Token | Value |
|---|---|
| `--cosmos-color-primary` | `#DB0A40` |
| `--cosmos-color-primary-darker` | `#C3093B` |
| `--cosmos-color-primary-lighter` | `#F50B48` |

### Surface — backgrounds, borders, box-shadows
Solid:
| Token | Value |
|---|---|
| `--cosmos-color-surface-solid-dark` | `#00162B` |
| `--cosmos-color-surface-solid-dark-darker` | `#000F1E` |
| `--cosmos-color-surface-solid-dark-lighter` | `#001C39` |
| `--cosmos-color-surface-solid-light` | `#F8F8F8` |
| `--cosmos-color-surface-solid-light-darker` | `#EFEFEF` |
| `--cosmos-color-surface-solid-light-lighter` | `#FFFFFF` |

Glass (transparent layers — for backgrounds/borders, pair with backdrop blur):
`--cosmos-color-surface-glass-dark-{5,10,20,45,60,80,90}` → `rgba(0,15,30, .05….9)`
`--cosmos-color-surface-glass-light-{5,10,20,45,60,80,90}` → `rgba(255,255,255, .05….9)`

### Text (also use for icons)
| Token | Value |
|---|---|
| `--cosmos-color-text-dark` | `#000F1E` |
| `--cosmos-color-text-dark-subtle` | `rgba(0,15,30,0.6)` |
| `--cosmos-color-text-light` | `#FFFFFF` |
| `--cosmos-color-text-light-subtle` | `rgba(255,255,255,0.6)` |

### Accent
| Token | Value | Use for |
|---|---|---|
| `--cosmos-color-accent-focus` | `#1B6AEE` | Focus states only (≥3:1 contrast, WCAG 2.1) |
| `--cosmos-color-accent-positive` | `#159D48` | Success feedback |
| `--cosmos-color-accent-negative` | `#DB0A40` | Critical/destructive actions (NOT user input errors) |
| `--cosmos-color-accent-inform` | `#E06600` | Info / invalid input / delayed state (prefer over negative) |

## Typography

### Font family
| Token | Value | Use |
|---|---|---|
| `--cosmos-font-family-text` | `'Bull Text', Helvetica, sans-serif` | Body / long text |
| `--cosmos-font-family-title` | `Bull, Helvetica, sans-serif` | Titles / headings |
| `--cosmos-font-family-text-variable` | `'Bull VF', Helvetica, sans-serif` | Variable-font body (needs font-variation-settings) |
| `--cosmos-font-family-title-variable` | `'Bull VF', Helvetica, sans-serif` | Variable-font titles |

Per-script families also exist: `--cosmos-font-family-arabic-{text,title}`,
`-thai-`, `-hindi-`, `-korean-`, `-japanese-`, `-hebrew-`, `-chinese-simplified-`,
`-chinese-traditional-` (`-text`/`-title`).

### Font weight (static fonts)
| Token | Value |
|---|---|
| `--cosmos-font-weight-regular` | `400` |
| `--cosmos-font-weight-medium` | `500` |
| `--cosmos-font-weight-bold` | `700` |
| `--cosmos-font-weight-heavy` | `800` |

Variable fonts use `font-variation-settings` tokens instead, e.g.
`--cosmos-font-weight-default-text-variable-bold` (`'opsz' 12, 'wght' 700`),
`--cosmos-font-weight-default-title-variable-heavy` (`'opsz' 86, 'wght' 800`).

### Type scale
Each step couples mobile/desktop font-size, line-height, and top/bottom spacing (vertical rhythm).
Token pattern: `--cosmos-type-{step}-font-size-{mobile|desktop}`, `-line-height`,
`-spacing-top`, `-spacing-bottom`.

| Step | Mobile | Desktop | Line-height |
|---|---|---|---|
| `xxxx-large` | 45px | 86px | 1 |
| `xxx-large` | 37px | 60px | 1.066667 |
| `xx-large` | 31px | 41px | 1.097561 |
| `x-large` | 26px | 29px | 1.137931 |
| `large` | 22px | 24px | 1.333333 |
| `medium` | 18px | 20px | 1.5 |
| `small` | 17px | 17px | 1.411765 |
| `x-small` | 14px | 14px | 1.357143 |
| `xx-small` | 12px | 12px | 1.25 |

Apply a step (mobile-first, bump size at a breakpoint):
```css
.headline {
  font-family: var(--cosmos-font-family-title);
  font-weight: var(--cosmos-font-weight-bold);
  font-size: var(--cosmos-type-xx-large-font-size-mobile);
  line-height: var(--cosmos-type-xx-large-line-height);
  margin-top: var(--cosmos-type-xx-large-spacing-top);
  margin-bottom: var(--cosmos-type-xx-large-spacing-bottom);
}
@media (min-width: 650px) { /* breakpoint-medium */
  .headline { font-size: var(--cosmos-type-xx-large-font-size-desktop); }
}
```

## Spacing (multiples of 4)
| Token | Value |
|---|---|
| `--cosmos-spacing-xx-tight` | 4px |
| `--cosmos-spacing-x-tight` | 8px |
| `--cosmos-spacing-tight` | 12px |
| `--cosmos-spacing-normal` | 16px |
| `--cosmos-spacing-loose` | 24px |
| `--cosmos-spacing-x-loose` | 32px |
| `--cosmos-spacing-xx-loose` | 40px |
| `--cosmos-spacing-xxx-loose` | 64px |
| `--cosmos-spacing-xxxx-loose` | 80px |

## Radius
| Token | Value |
|---|---|
| `--cosmos-radius-none` | 0 |
| `--cosmos-radius-small` | 2px |
| `--cosmos-radius-medium` | 6px |
| `--cosmos-radius-large` | 8px |
| `--cosmos-radius-full` | 9999px (pills/circles) |

## Border width
| Token | Value | Use |
|---|---|---|
| `--cosmos-border-thin` | 1px | Contrast/structure |
| `--cosmos-border-medium` | 2px | Affordance of interactive elements |

## Elevation (box-shadow)
| Token | Value |
|---|---|
| `--cosmos-elevation-1-above` | `0px 8px 12px 0px rgba(0,15,30,.04), 0px 2px 4px 0px rgba(0,15,30,.02)` |
| `--cosmos-elevation-2-above` | `0px 16px 24px 0px rgba(0,15,30,.06), 0px 4px 8px 0px rgba(0,15,30,.02)` |

Higher level = closer to the user. Apply via `box-shadow: var(--cosmos-elevation-1-above);`

## Backdrop blur
| Token | Value |
|---|---|
| `--cosmos-backdrop-blur-medium` | 10px |

Use on glass surfaces: `backdrop-filter: blur(var(--cosmos-backdrop-blur-medium));`

## Breakpoints
| Token | Min width |
|---|---|
| `--cosmos-breakpoint-small` | ≥ 0 |
| `--cosmos-breakpoint-medium` | ≥ 650px |
| `--cosmos-breakpoint-large` | ≥ 1000px |
| `--cosmos-breakpoint-x-large` | ≥ 1200px |
| `--cosmos-breakpoint-xx-large` | ≥ 1350px |

Design reference frames: Mobile 375px, Tablet 768px, Desktop 1440px.
(CSS `@media` can't read a custom property in the condition — use the px values above, or a
preprocessor variable if using SCSS/LESS/Stylus.)

## Full Example
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://rbds-static.redbull.com/@cosmos/foundation/latest/index.css">
  <link rel="stylesheet" href="https://rbds-static.redbull.com/@cosmos/foundation/latest/fonts/default.css">
  <style>
    body {
      margin: 0;
      font-family: var(--cosmos-font-family-text);
      color: var(--cosmos-color-text-dark);
      background: var(--cosmos-color-surface-solid-light);
    }
    .card {
      max-width: 360px;
      margin: var(--cosmos-spacing-xxx-loose) auto;
      padding: var(--cosmos-spacing-loose);
      background: var(--cosmos-color-surface-solid-light-lighter);
      border: var(--cosmos-border-thin) solid var(--cosmos-color-surface-glass-dark-10);
      border-radius: var(--cosmos-radius-large);
      box-shadow: var(--cosmos-elevation-1-above);
    }
    .card h2 {
      margin: 0 0 var(--cosmos-spacing-tight);
      font-family: var(--cosmos-font-family-title);
      font-weight: var(--cosmos-font-weight-bold);
      font-size: var(--cosmos-type-large-font-size-mobile);
      line-height: var(--cosmos-type-large-line-height);
    }
    .card p {
      margin: 0 0 var(--cosmos-spacing-normal);
      color: var(--cosmos-color-text-dark-subtle);
      font-size: var(--cosmos-type-small-font-size-mobile);
      line-height: var(--cosmos-type-small-line-height);
    }
    .btn {
      font: inherit;
      font-weight: var(--cosmos-font-weight-medium);
      color: var(--cosmos-color-text-light);
      background: var(--cosmos-color-primary);
      border: 0;
      border-radius: var(--cosmos-radius-full);
      padding: var(--cosmos-spacing-x-tight) var(--cosmos-spacing-loose);
      cursor: pointer;
    }
    .btn:hover { background: var(--cosmos-color-primary-darker); }
    .btn:focus-visible { outline: var(--cosmos-border-medium) solid var(--cosmos-color-accent-focus); }
  </style>
</head>
<body>
  <article class="card">
    <h2>Stay curious</h2>
    <p>Built with Cosmos foundation primitives.</p>
    <button class="btn" type="button">Get started</button>
  </article>
</body>
</html>
```

## Checklist before shipping markup
- [ ] No raw hex/rgb for brand colors — all via `--cosmos-color-*`
- [ ] Color tokens chosen by role (primary/surface/text/accent)
- [ ] Spacing/padding from `--cosmos-spacing-*` (4-based)
- [ ] Radii, border widths, shadows, blur from tokens
- [ ] Text uses a type-scale step (size + line-height + spacing together) and a `--cosmos-font-family-*`
- [ ] Focus states use `--cosmos-color-accent-focus`
- [ ] Foundation CSS + correct font CSS loaded for the target language(s)
