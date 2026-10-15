---
name: show-me
description: Build one slim, self-contained HTML artifact that makes an idea click — a decision, a trade-off, a risk, a process, a system, an unfamiliar concept. The artifact explains the subject itself and never recaps the conversation that produced it. Routes by the shape of the person's confusion rather than the subject matter, and reaches for named explanation frames (Minto, Cynefin, Gigerenzer, Tufte, Roam, Gentner, Meadows) to steer toward a specific way of thinking instead of a generic diagram. Use this whenever someone says "I don't get it", "explain", "show me", "help me decide", "what are my options", "compare these", "walk me through", "is this risky", or has clearly buried the answer in a wall of prose — even if they never ask for a picture. Also use it when a conversation has produced a lot of scattered findings and someone needs to see the whole thing at once.
---

Open with a short orientation, then answer. Keep prose brief and pick the smallest thing that makes the point land.

## 1. Name the confusion before picking a form

The form follows the confusion, never the subject. "A trade-off with no clean answer" is the same explanatory problem whether it's a database choice or a school district budget — and the same picture solves both. Ask yourself: **after reading this, what should they be able to do that they can't do now?** Decide? Predict? Explain it back to someone else? Stop worrying?

Then, before building anything, check that the visual earns its cost. A sentence beats a diagram; a three-row table beats a chart. Reach for HTML when the point is *spatial, proportional, relational, or comparative* — when the reader would otherwise have to hold several things in their head at once and rotate them.

## 2. Build the idea, not the session

This is the one rule that matters most, and the one easiest to break without noticing.

Your context is a transcript, so the conversation feels like the subject. It isn't. The subject is whatever the conversation was *about* — the mechanism, the trade-off, the risk, the system. Build that. The artifact should read as though the idea existed before anyone discussed it, because it did.

**The test: a stranger opens this file, has never read a single message, and still gets it.** Nothing in it should require having been there. If it does, rebuild.

Minto's real point is not "answer first" — it's that **the order you figured something out is almost never the order to explain it in.** You got here by ruling things out, circling back, changing your mind. None of that is load-bearing for understanding. Reorganize from scratch around what the reader needs to grasp the thing.

Tells that the session has leaked in:

- "we", "you asked", "as discussed", "based on our conversation"
- session chronology: initially / then / after digging in / it turns out
- options present only because they came up, not because they illuminate the answer
- a before/after where "before" is just the earlier state of the discussion
- anything that makes a stranger ask "before what?" or "who's we?"
- the artifact's structure mirroring the order things were talked about

Alternatives and dead ends belong in only when a reader independently needs them to understand or trust the answer — and then as a comparison on the merits, stripped of any trace of when they came up. Real process order and real historical change still belong; only discovery order doesn't.

## 3. Route: confusion → frame → form

Invoke the named frame explicitly in your own reasoning. The name is the steering wheel — "structure this as an SCQA" and "structure this clearly" produce very different work. The frames guide the relationships you show; don't invent axes or coordinates to fill a template.

| The person's confusion | Frame to think with | Form to build |
| --- | --- | --- |
| "There's no bottom line — this is a wall of points" | **Minto's Pyramid / SCQA** (Situation, Complication, Question, Answer) — answer at the end of the lead, then 2–3 MECE supporting groups | One governing sentence, nested support |
| "I can't see the trade-off between these" | **2×2 matrix** (Eisenhower, BCG) — only when two independent axes explain the choice; otherwise a comparison table | CSS-grid quadrant with the options placed in it |
| "I'm applying best practice and it isn't working" | **Cynefin** (Snowden) — clear / complicated / complex / chaotic, each needing a different response. Domains, not measured axes | Four domains with the situation placed and the matching response named |
| "What are the actual odds here?" | **Natural frequencies** (Gigerenzer) — counts with explicit denominators; "9 of the 98 who test positive actually have it" | Frequency tree, or an icon array of the real denominator |
| "How big is this really?" | **Icon array / waffle** — a concrete population, some of it shaded | CSS grid, grouped not scattered, with the number alongside |
| "Did this get better or worse?" | **Slopegraph** (Tufte) — two states, one line each | Inline SVG, two columns, direct labels |
| "How does this vary across all of them?" | **Small multiples** (Tufte) — one shape repeated on a shared scale | Grid of tiny identical bars or lines |
| "Why does this keep happening?" | **Causal loops & system archetypes** (Meadows, Senge — fixes that fail, shifting the burden, limits to growth) | Inline SVG graph with reinforcing/balancing loops marked |
| "I've never seen anything like this before" | **Structure-mapping** (Gentner) — map the *relations* of a familiar thing onto the unfamiliar one, not surface features | Side-by-side base/target with the shared relations drawn between |
| "What happens in what order?" | **Timeline / stepper** | Flex rows with connectors; mark the step that actually matters |
| "One number is the whole story" | **Big number** | A single stat card: number, label, and what it's up against |
| "This is a lot — where do I even start?" | **Shneiderman's mantra** — overview first, zoom and filter, details on demand | Summary at top, `<details>` for everything beneath |

You will use one of these, sometimes two. You will not use all of them. When nothing fits, you also know SWOT, fishbone, five whys, pre-mortem, jobs-to-be-done, decision trees, Sankey flows, and Vonnegut's story shapes — reach for them by name.

## 4. Craft rules, in priority order

These are not taste. They're the findings.

1. **Cut, don't decorate.** Excluding extraneous material is the best-evidenced move in the multimedia learning literature, and decorative extras measurably *hurt* comprehension. No stock illustration, no gradient, no flourish. If it isn't carrying the point, delete it.
2. **Put the words on the picture.** Labels belong at the thing they label, not in a legend the reader has to cross-reference — forcing that mental join is pure wasted effort (split-attention). Direct-label every bar, line and connection.
3. **One accent color, doing real work.** Neutral grays for everything, one saturated color reserved for the thing that matters, with one meaning per visual. Use several colors only for categories, from the Okabe–Ito colorblind-safe set (`#0072B2 #E69F00 #009E73 #D55E00 #CC79A7 #56B4E9`) — blue and orange is the safest pair. Encode with length and position before hue, check text contrast, and never let color be the only cue.
4. **Open with kicker, topic title, lead.** The page opens in this order:
   - **Kicker:** where the subject sits, e.g. "Payments API · Refund retries (PAY-412)". Take it from the source material (README title, an explicit project heading, a ticket or ADR that matches this page's topic), not from the conversation or the branch name. Topic match beats source rank. Leave out any part you can't verify; never research just to fill it.
   - **Title (h1):** names the topic in 3 to 8 words, as a noun phrase, often "Topic: angle". "Refund retries: when a failed refund is safe to repeat", not "Seven of nine failure codes are safe to retry".
   - **Lead:** 2 or 3 sentences. Say what the subject is, then what the reader can do with this page. End with the answer in one bold sentence.
5. **Section titles assert the finding.** "Support costs doubled after the migration," not "Support costs over time." Keep the conditions a claim depends on next to it. The page title names the topic instead (see rule 4). Format numbers for humans: $1.2M, not 1200000.
6. **Typographic minimums.** System font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`), `max-width: 65ch` on text, `line-height: 1.5`, generous whitespace, more space between sections than within them. No borders that don't encode anything.
7. **Don't repeat the diagram in a caption.** If the visual works, saying the same thing twice adds load. Add text only for the takeaway, a needed caveat, or an accessible equivalent.

Avoid the house style of AI-generated pages: centered everything, purple gradients, uniformly rounded corners, Inter. Those read as machine-made on sight.

## 5. Build it, ideally with a separate builder

You do steps 1 to 4 yourself: you know the subject, so you pick the confusion, the frame, the form, the opening, the titles and every fact. Layout and implementation are a separate job that takes real judgment about reading order, wrapping and accessibility, and a fresh context does it better.

Write a build brief to `{workdir}/brief.md`. Use a persistent directory such as `~/.cache/showme/{topic}-{yyyymmdd}/`, not `/tmp`, so a restart doesn't wipe it. The brief contains:

- the file path to write (`{workdir}/{topic}.html`) and the medium: screen, print to A4, or both
- the audience, what they already know, and what they should be able to do afterwards
- the exact kicker, title, lead and bold answer sentence (rule 4)
- the frame and form you chose, in one line each
- the sections in order: each with its asserting title, its form (stat card, table, quadrant, steps, `<details>`...), and the exact text, numbers and conditions it carries
- for every diagram, each edge as **sender → receiver: payload**. Arrows, order, grouping and scale are claims, not layout
- labels for what exists, what is proposed and what is uncertain
- what the accent color marks
- an opening role line: cast the builder as an information designer for this audience, not as the subject expert

Before you hand it over, preflight the brief: counts match the lists, every diagram edge matches the prose, each title claims no more than its section supports, and the conditions sit next to the claims they limit.

### If your harness supports subagents

Hand the brief to a builder subagent instead of writing the HTML yourself.

- **Model:** a strong mid-tier model with extended reasoning enabled. Use your strongest model when the page carries a flow or relationship diagram; it is likelier to catch an edge that contradicts the prose.
- **Tools:** file read, write and edit, plus a shell for PDF rendering.
- **Working directory:** `{workdir}`.
- **Prompt:** "Read `<path to this SKILL.md>` sections 4 and 5b (craft rules and build rules), then `{workdir}/brief.md`. Build the file the brief names. For print, render a PDF with headless Chrome and render every page to PNG as 5b describes. Reply with the file path, the page count, every change you made under the licence in 5b, and anything in the brief you couldn't follow."

Run it in the background if you can and continue other work. When it finishes, read its reply, then verify (section 6). If the harness can resume a subagent, send fixes to the same one, since it already holds the layout context. End it only after verification, then open the file.

### If not

Build it yourself, in a separate step after the brief is final. Follow 5b as if you were the builder, and don't change the brief's claims while you lay them out. Then verify (section 6) with the same strictness.

## 5b. Build rules (for the builder)

**Licence.** Preserve the brief's wording and facts. You decide spacing, wrapping, grouping on the page and geometry within the stated relationships. If the brief contradicts itself (a diagram edge against its own prose, a count against its own list), apply the fix the brief's prose supports and flag each one in your reply. Never add, cut or reword a claim, change a recommendation, or resolve an uncertainty the brief leaves open; quote those and stop.

Write a single self-contained HTML file: all CSS and assets inline, no runtime network requests, no build step, no npm, no framework. One exception: if a design-system skill tells you to link its hosted stylesheet or fonts, do exactly that. Don't download or embed licensed fonts, and keep a hex fallback on every CSS variable so the page still reads offline.

Cost hierarchy, cheapest first: **pure HTML/CSS for quantities and comparisons** (div-width bars, grid waffles, quadrants, stat cards, `<details>`) → **inline SVG for custom geometry** (slopegraphs, connectors, trees, causal loops, annotation layers). Keep meaningful text in the markup, add `aria-label` to CSS-only charts, and give every diagram a text equivalent that states its relationships, not just its topic.

For print: `@page{size:A4;margin:16mm}`, `print-color-adjust:exact`, keep a heading with its first paragraph or row (`break-inside:avoid` on small units, never on whole sections), repeat table headers with `thead{display:table-header-group}`, expand `<details>`. Render every page to PNG (see below) and look at each one.

### Rendering PDF pages to PNG

Use the first option that works on this machine:

1. `pdftoppm -png -r 90 print.pdf page` (poppler)
2. `mutool draw -r 90 -o page-%d.png print.pdf` (MuPDF)
3. On macOS with no extra tools, write this to `{workdir}/pdf-pages.swift` and run `swift pdf-pages.swift print.pdf page`. It writes `page-1.png`, `page-2.png`, … and prints the page count:

   ```swift
   import PDFKit; import AppKit
   let a=CommandLine.arguments; let doc=PDFDocument(url: URL(fileURLWithPath:a[1]))!
   for i in 0..<doc.pageCount { let p=doc.page(at:i)!; let r=p.bounds(for:.mediaBox); let s:CGFloat=1.2
    let img=NSImage(size:NSSize(width:r.width*s,height:r.height*s)); img.lockFocus(); NSColor.white.set(); NSRect(x:0,y:0,width:r.width*s,height:r.height*s).fill()
    let ctx=NSGraphicsContext.current!.cgContext; ctx.scaleBy(x:s,y:s); p.draw(with:.mediaBox,to:ctx); img.unlockFocus()
    let rep=NSBitmapImageRep(data:img.tiffRepresentation!)!; try! rep.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:"\(a[2])-\(i+1).png")) }
   print(doc.pageCount)
   ```

4. If none of these work, report print layout as unverified. Don't install tools without asking.

These tools only render the pages. You still look at every PNG yourself.

## 6. Verify meaning, then rendering

You own the final check, not the builder.

1. **Meaning.** Compare the HTML with the brief: arrows and their senders, order, grouping, numbers, conditions, hidden `<details>` content. Accept or undo every change the builder flagged.
2. **Rendering.** For screen, look at a desktop and a narrow viewport. For print, export an A4 PDF, render every page (see 5b) and look at each PNG. Look for clipping, orphaned blocks and a last page with one lonely section.
3. If a check couldn't run, say what is unverified. Don't claim print support from CSS alone.

## 7. Then say almost nothing

Put the artifact next to the one or two sentences it supports. Don't narrate what you built, don't list the techniques you considered, don't offer three follow-ups. The whole point is that the picture does the talking.

Last check before you hand it over: read the file as a stranger would. If it explains the idea, it's done. If it explains how you got there, start again.
