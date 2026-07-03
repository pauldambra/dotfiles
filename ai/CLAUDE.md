# Approach to work

I like "Simple code" that means:

* Passes all the tests.
* Expresses every idea that we need to express.
* Says everything OnceAndOnlyOnce.
* has no superfluous parts

These are called the simplicity rules.

These rules are in conflict with each other. Sometimes to express every idea we can't say everything only once. We look to balance these rules with a focus to future maintainers having an easier time.

Also... it means we work in three stages

* make it work
* make it right
* make it fast

We should always pause and consider if the working code should be improved to make it simpler or to make it faster, but only once we're sure it works

There is no such thing as "pre-existing failures that we don't need to fix"
The decision is always if we fix them in this piece of work or open a quick PR specific to the fix.

* changes that align with our current work: fix in the current PR
* very small off-topic changes: open them in their own PR
* very large changes: open a separate PR, stacking as necessary

The work of software engineering is to keep the software buildable, workable, maintainable, and valuable.

# delegation

For all coding tasks use your judgement to decide if there is an appropriate lower power model and run that in a subagent

fable can use its own judgement on whether to delegate to any model. opus can choose to delegate implementation to sonnet.

# tests

i prefer TDD

i don't try to test everything. weigh the value of a test against the speed of testing at that layer.

tests are about protecting future changes as much as validating the current change. every test answers three questions:

* do i know the code does not already do this?
* will i know it does it when i am finished?
* will i know it still does it tomorrow?

IMPORTANT: prefer parameterized tests

# comments

every time we see a comment we ask

* should this be a rename refactoring
* should this be an extract method refactoring

comments are visual noise when they only duplicate information that is present in the code

often applying the simplicity rules removes them

NOTE: never remove comments that are already present in the code, only edit comments you have added

# graphite

i prefer graphite for git work. the `gt` cli and the graphite mcp (`mcp__graphite__run_gt_cmd`) should always be present on my machines - assume they are available.

prefer the graphite mcp over raw git for anything touching a stack - `gt restack`, `gt submit`, `gt sync`. raw `git rebase` or `git push --force-with-lease` on a stacked branch bypasses graphite's base tracking and breaks the stack. only fall back to raw git when no gt equivalent exists.

# code formatting in chat

never use programming-ligature characters (e.g. → ← ⇒ ≠ ≥ ≤) when displaying code or technical content. they hurt legibility in my terminal. use ascii equivalents (->, <-, =>, !=, >=, <=).

# time estimates

never estimate time for tasks ("this is a one-day change", "~1 hour of work", "quick fix vs big refactor in time terms"). your training reflects how long humans take, not how long you take. estimate by complexity instead: lines of code touched, number of files, surface area of behaviour change, whether perf benchmarking is needed, etc.

# validating this file has been read

if i say "cuckoo", you say "Phil Haack has taught me well"
