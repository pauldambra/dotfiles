---
name: no programming ligatures in code/chat
description: Never use programming ligature characters (→, ←, ⇒, ≠, ≥, ≤, etc.) when displaying code or technical content; use ASCII equivalents
type: feedback
originSessionId: 019db84a-451a-73b2-bf31-9bae13bb1e08
---
Never render programming-ligature characters (`→`, `←`, `⇒`, `≠`, `≥`, `≤`, `≡`, `≅`, etc.) in code blocks, diagrams, or technical prose. Use ASCII equivalents (`->`, `<-`, `=>`, `!=`, `>=`, `<=`).

**Why:** They hurt legibility in the user's terminal — likely a font / rendering issue where the glyphs collapse to look like adjacent characters or render as boxes.

**How to apply:** Whenever drafting code, ASCII flow diagrams, before/after tables, or even casual prose like "X → Y means…", spell the arrow out as `->`. Applies in chat output, file contents I write, and PR descriptions.
