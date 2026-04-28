# Memory Index

## Feedback
- [feedback_use_graphite_mcp.md](feedback_use_graphite_mcp.md) - Always use Graphite MCP tools instead of raw git for stack operations
- [feedback_prefer_frozen_dataclasses.md](feedback_prefer_frozen_dataclasses.md) - Prefer `@dataclass(frozen=True)` over `typing.NamedTuple` for small Python result/record types
- [feedback_drop_snapshots_only_commits.md](feedback_drop_snapshots_only_commits.md) - When adopting a PR, drop commits whose only change is frontend/snapshots.yml
- [feedback_no_ligatures.md](feedback_no_ligatures.md) - Never use programming-ligature characters (use ASCII like ->, !=, >=)
- [feedback_no_time_estimates.md](feedback_no_time_estimates.md) - Never estimate time for tasks; describe complexity instead (LOC, files, call sites)
- [feedback_check_pr_draft_state.md](feedback_check_pr_draft_state.md) - PR Approval Agent silently skips on draft PRs; check isDraft before adding stamphog label
- [feedback_always_parameterise_tests.md](feedback_always_parameterise_tests.md) - Always parameterise tests when there are multiple cases of the same shape (jest describe.each, pytest parameterized, Go table-driven)
- [feedback_prefer_listeners_over_subscriptions.md](feedback_prefer_listeners_over_subscriptions.md) - In kea logics, prefer listeners (or afterMount + propsChanged) over kea-subscriptions — they're slower
