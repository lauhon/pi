---
name: show-me
description: Make the current topic click by building one slim, self-contained HTML artifact — a decision, a trade-off, a risk, a process, a system, an unfamiliar concept. Routes by the shape of the person's confusion rather than the subject, and reaches for named explanation frames (Minto, Cynefin, Gigerenzer, Tufte, Roam, Gentner, Meadows) to steer toward a specific way of thinking instead of a generic diagram. Use this whenever someone says "I don't get it", "explain", "show me", "help me decide", "what are my options", "compare these", "walk me through", "is this risky", or has clearly buried the answer in a wall of prose — even if they never ask for a picture. Also use it when a conversation has produced a lot of scattered findings and someone needs to see the whole thing at once.
---
 
Make the current topic clear. Skip the preamble, keep prose brief, and pick the smallest thing that makes the point land.
 
## 1. Name the confusion before picking a form
 
The form follows the confusion, never the subject. "A trade-off with no clean answer" is the same explanatory problem whether it's a database choice or a school district budget — and the same picture solves both. Ask yourself: **after reading this, what should they be able to do that they can't do now?** Decide? Predict? Explain it back to someone else? Stop worrying?
 
Then, before building anything, check that the visual earns its cost. A sentence beats a diagram; a three-row table beats a chart. Reach for HTML when the point is *spatial, proportional, relational, or comparative* — when the reader would otherwise have to hold several things in their head at once and rotate them.
 
## 2. Route: confusion → frame → form
 
Invoke the named frame explicitly in your own reasoning. The name is the steering wheel — "structure this as an SCQA" and "structure this clearly" produce very different work.
 
| The person's confusion | Frame to think with | Form to build |
| --- | --- | --- |
| "There's no bottom line — this is a wall of points" | **Minto's Pyramid / SCQA** (Situation, Complication, Question, Answer) — answer first, then 2–3 MECE supporting groups | Answer-first prose, one governing sentence, nested support |
| "I can't see the trade-off between these" | **2×2 matrix** (Eisenhower, BCG) — two independent axes, four quadrants | CSS-grid quadrant with the options placed in it |
| "I'm applying best practice and it isn't working" | **Cynefin** (Snowden) — clear / complicated / complex / chaotic, each needing a different response | 2×2 with the situation placed and the matching response named |
| "What are the actual odds here?" | **Natural frequencies** (Gigerenzer) — never percentages; "9 of the 98 who test positive actually have it" | Frequency tree, or an icon array of 100 |
| "How big is this really?" | **Icon array / waffle** — a concrete population, some of it shaded | 10×10 CSS grid, grouped not scattered, with the number alongside |
| "Did this get better or worse?" | **Slopegraph** (Tufte) — two states, one line each | Inline SVG, two columns, direct labels |
| "How does this vary across all of them?" | **Small multiples** (Tufte) — one shape repeated on a shared scale | Grid of tiny identical bars or lines |
| "Why does this keep happening?" | **Causal loops & system archetypes** (Meadows, Senge — fixes that fail, shifting the burden, limits to growth) | Mermaid graph with reinforcing/balancing loops marked |
| "I've never seen anything like this before" | **Structure-mapping** (Gentner) — map the *relations* of a familiar thing onto the unfamiliar one, not surface features | Side-by-side base/target with the shared relations drawn between |
| "What happens in what order?" | **Timeline / stepper** | Flex rows with connectors; mark the step that actually matters |
| "One number is the whole story" | **Big number** | A single stat card: number, label, and what it's up against |
| "This is a lot — where do I even start?" | **Shneiderman's mantra** — overview first, zoom and filter, details on demand | Summary at top, `<details>` for everything beneath |
 
You will use one of these, sometimes two. You will not use all of them. When nothing fits, you also know SWOT, fishbone, five whys, pre-mortem, jobs-to-be-done, decision trees, Sankey flows, and Vonnegut's story shapes — reach for them by name.
 
## 3. Craft rules, in priority order
 
These are not taste. They're the findings.
 
1. **Cut, don't decorate.** Excluding extraneous material is the single best-evidenced move in the multimedia learning literature (supported in 23 of 23 tests, median effect ~0.86), and decorative extras measurably *hurt* comprehension. No stock illustration, no gradient, no flourish. If it isn't carrying the point, delete it.
2. **Put the words on the picture.** Labels belong at the thing they label, not in a legend the reader has to cross-reference — forcing that mental join is pure wasted effort (split-attention). Direct-label every bar and line.
3. **One accent color, doing real work.** Neutral grays for everything, one saturated color reserved for the thing that matters. For categories use the Okabe–Ito colorblind-safe set (`#0072B2 #E69F00 #009E73 #D55E00 #CC79A7 #56B4E9`) — blue and orange is the safest pair. Encode with length and position before hue.
4. **Titles assert the finding.** "Support costs doubled after the migration," not "Support costs over time." Format numbers for humans: $1.2M, not 1200000.
5. **Typographic minimums.** System font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`), `max-width: 65ch` on text, `line-height: 1.5`, generous whitespace, more space between sections than within them. No borders that don't encode anything.
6. **Don't repeat the diagram in a caption.** If the visual works, saying the same thing twice adds load rather than reinforcement — especially for someone who already knows the domain.
Avoid the house style of AI-generated pages: centered everything, purple gradients, uniformly rounded corners, Inter. Those read as machine-made on sight.
 
## 4. Build it as one file
 
Write a single self-contained HTML file — all CSS inline, no build step, no npm, no framework. Then open it:
 
```
Bash(open /tmp/clear-{topic}-{yyyymmdd}.html)
```
 
Cost hierarchy, cheapest first: **pure HTML/CSS for quantities and comparisons** (div-width bars, grid waffles, quadrants, stat cards, `<details>`) → **inline SVG for simple custom geometry** (slopegraphs, connectors, annotation layers) → **one Mermaid CDN include, and only for branching and flow** (frequency trees, decision trees, causal loops), where hand-computing connector coordinates is genuinely expensive.
 
Two notes on that: a CSS-only bar chart is invisible to screen readers, so keep real text in the markup and add `aria-label`. And the Mermaid CDN only works because the file is opened locally — the same file pasted into a sandboxed artifact viewer will block the request, so go pure SVG if it needs to travel.
 
## 5. Then say almost nothing
 
Put the artifact next to the one or two sentences it supports. Don't narrate what you built, don't list the techniques you considered, don't offer three follow-ups. The whole point is that the picture does the talking.
