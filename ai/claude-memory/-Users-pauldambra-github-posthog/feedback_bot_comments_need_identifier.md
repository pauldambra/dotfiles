---
name: feedback_bot_comments_need_identifier
description: "Every GitHub comment an agent posts must start with a bot-identifier banner, including ad-hoc author replies"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 019e8d4f-9856-71f6-bbdd-3e5e4c19a02e
---

Any comment I post to GitHub on the user's behalf (PR comments, review replies, issue comments — including ad-hoc author replies I compose myself, not just skill-driven ones) must begin with a clear bot-identifier banner, e.g.:

```
> [!NOTE]
> 🤖 Automated comment by **PostHog Code** — not written by a human
```

**Why:** a human reader must be able to tell at a glance that a comment was machine-written. The qa-swarm and [[feedback_pr_shepherd_mark_ready]] / pr-shepherd skills already mandate this header, but a point-by-point review reply I hand-wrote outside those skills went out without it, and the user asked me to fix it.

**How to apply:** prepend the banner to the body of *every* comment before posting — don't rely on a trailing `Generated-By:` trailer alone. If a comment already posted lacks it, PATCH it via `gh api repos/<owner>/<repo>/issues/comments/<id> -X PATCH -f body=...`.
