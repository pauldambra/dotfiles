# Memory Index

## Feedback
- [feedback_bot_comments_need_identifier.md](feedback_bot_comments_need_identifier.md) - Every GitHub comment an agent posts must lead with a bot-identifier banner, including hand-written author replies
- [feedback_use_graphite_mcp.md](feedback_use_graphite_mcp.md) - Always use Graphite MCP tools instead of raw git for stack operations
- [feedback_restack_preapproved_on_stacks.md](feedback_restack_preapproved_on_stacks.md) - On a Graphite stack, restacking is pre-approved — don't ask before gt restack/submit to propagate base changes upstack
- [feedback_prefer_frozen_dataclasses.md](feedback_prefer_frozen_dataclasses.md) - Prefer `@dataclass(frozen=True)` over `typing.NamedTuple` for small Python result/record types
- [feedback_drop_snapshots_only_commits.md](feedback_drop_snapshots_only_commits.md) - When adopting a PR, drop commits whose only change is frontend/snapshots.yml
- [feedback_no_ligatures.md](feedback_no_ligatures.md) - Never use programming-ligature characters (use ASCII like ->, !=, >=)
- [feedback_no_time_estimates.md](feedback_no_time_estimates.md) - Never estimate time for tasks; describe complexity instead (LOC, files, call sites)
- [feedback_check_pr_draft_state.md](feedback_check_pr_draft_state.md) - PR Approval Agent silently skips on draft PRs; check isDraft before adding stamphog label
- [feedback_always_parameterise_tests.md](feedback_always_parameterise_tests.md) - Always parameterise tests when there are multiple cases of the same shape (jest describe.each, pytest parameterized, Go table-driven)
- [feedback_prefer_listeners_over_subscriptions.md](feedback_prefer_listeners_over_subscriptions.md) - In kea logics, prefer listeners (or afterMount + propsChanged) over kea-subscriptions — they're slower
- [feedback_prefer_assert_over_assertequal.md](feedback_prefer_assert_over_assertequal.md) - Prefer plain `assert x == y` over `self.assertEqual` in Python tests for richer pytest failure output
- [feedback_pr_shepherd_mark_ready.md](feedback_pr_shepherd_mark_ready.md) - When running pr-shepherd, auto-mark draft PRs ready for review before starting the loop
- [feedback_leak_hunting_offheap.md](feedback_leak_hunting_offheap.md) - Leak hunting targets off-heap memory (detached DOM, native allocations) not JS heap; use measureUserAgentSpecificMemory or CDP, not performance.memory
- [feedback_no_absolute_counts_in_public_prs.md](feedback_no_absolute_counts_in_public_prs.md) - PostHog/posthog PRs/commits must justify with percentages or ratios, never absolute production counts (users, events, revenue)
- [feedback_ship_changes_behind_experiments.md](feedback_ship_changes_behind_experiments.md) - For changes aimed at moving product metrics, suggest shipping as an A/B test — judgment call, not a hard rule

## Reference
- [reference_stamphog_anthropic_key_auth.md](reference_stamphog_anthropic_key_auth.md) - stamphog failing fleet-wide? It uses its own org secret STAMPHOG_ANTHROPIC_API_KEY; SDK error "error result: success" = CLI auth failure
- [reference_paul_llm_analytics_identity.md](reference_paul_llm_analytics_identity.md) - In project 2 LLM analytics, scope "my usage" by person.properties.email, not distinct_id

## Project
- [project_user_interviews_embedding_access.md](project_user_interviews_embedding_access.md) - user_interviews transcripts in document_embeddings: team_id is the only enforced isolation; HogQL-readable under query:read is accepted
- [project_pageview_auth_only.md](project_pageview_auth_only.md) - $pageview events on us/eu.posthog.com only fire for authenticated PostHog users — cohorts are auth-only, not noisy
- [project_taxonomic_filter_research.md](project_taxonomic_filter_research.md) - replay-vision scanner + user-interview topic researching taxonomic-filter friction; scanner/topic IDs and early findings
- [project_pr_shepherd_model_split.md](project_pr_shepherd_model_split.md) - pr-shepherd already pins reviews=Opus, mechanical=Sonnet subagents; orchestration inherits session model, so launch the loop on Sonnet
