---
name: Consider A/B tests for product-metric changes
description: When proposing a change aimed at moving a product metric, suggest shipping as an A/B test — but it is a judgment call, not a hard rule
type: feedback
originSessionId: 019e6024-2562-71fc-b2a5-e5099f69a197
---
When proposing a change whose purpose is to move a product metric (retention, conversion, engagement breadth, etc), suggest shipping it as an A/B test (experiment) so the impact is measurable. This is a judgment call, not a blanket rule — Paul does not always ship behind experiments.

**Why:** For changes that are explicitly trying to improve a measurable metric, a flag flip leaves us with pre/post comparisons muddied by seasonality, concurrent launches, and self-selection. An experiment gives a clean causal estimate against a contemporaneous control. Recent example: the AI-first homepage rolled out as a flag flip rather than an experiment — so we can only do pre/post analysis with weekly seasonality confounds and no clean read on true effect size.

**How to apply:** When the proposal is "change X to improve metric Y," include experiment design (variants, primary metric, guardrails, exposure event) in the proposal. When the proposal is operational (perf, bug fix, refactor, infra change with no expected behavior delta), a flag rollout is fine. Use judgment — do not insist on an experiment for every change.
