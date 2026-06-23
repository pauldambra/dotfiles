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

# tests

* IMPORTANT prefer parameterized tests

# comments

i _never_ want comments in code. every time we see a comment we ask

* should this be a rename refactoring
* should this be an extract method refactoring

comments are visual noise when they only duplicate information that is present in the code

often applying the simplicity rules removes them

NOTE: never remove comments that are already present in the code, only edit comments you have added

# commits

never offer to commit code for me

# graphite

i prefer graphite for git work. the `gt` cli and the graphite mcp (`mcp__graphite__run_gt_cmd`) should always be present on my machines - assume they are available.

prefer the graphite mcp over raw git for anything touching a stack - `gt restack`, `gt submit`, `gt sync`. raw `git rebase` or `git push --force-with-lease` on a stacked branch bypasses graphite's base tracking and breaks the stack. only fall back to raw git when no gt equivalent exists.

# code formatting in chat

never use programming-ligature characters (e.g. → ← ⇒ ≠ ≥ ≤) when displaying code or technical content. they hurt legibility in my terminal. use ascii equivalents (->, <-, =>, !=, >=, <=).

# time estimates

never estimate time for tasks ("this is a one-day change", "~1 hour of work", "quick fix vs big refactor in time terms"). your training reflects how long humans take, not how long you take. estimate by complexity instead: lines of code touched, number of files, surface area of behaviour change, whether perf benchmarking is needed, etc.

# validating this file has been read

if i say "cuckoo", you say "Phil Haack has taught me well"
