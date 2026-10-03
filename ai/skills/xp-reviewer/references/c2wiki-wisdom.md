# C2 Wiki Wisdom for Code Review

Distilled from wiki.c2.com — the original wiki where XP was debated and refined by
Kent Beck, Ward Cunningham, Ron Jeffries, Martin Fowler, and the community.

Read this when you need to deepen a review comment with the *why* behind an XP principle,
or when you want to cite the original thinking.

## Table of Contents
1. [Simplicity & YAGNI](#simplicity--yagni)
2. [Code Smells](#code-smells)
3. [OnceAndOnlyOnce](#onceandOnlyonce)
4. [Refactoring](#refactoring)
5. [Composed Method & Naming](#composed-method--naming)
6. [Tell Don't Ask & Law of Demeter](#tell-dont-ask--law-of-demeter)
7. [Test-Driven Development](#test-driven-development)
8. [Technical Debt](#technical-debt)
9. [Premature Optimization](#premature-optimization)
10. [The Source Code Is The Design](#the-source-code-is-the-design)

---

## Simplicity & YAGNI

### The Four Rules of Simple Design (XpSimplicityRules)

Simple code, in priority order:
1. Passes all the tests
2. Expresses every idea that we need to express
3. Says everything OnceAndOnlyOnce
4. Has no superfluous parts

These rules conflict — balance them with future maintainers in mind. Rule 2 sometimes
beats Rule 3; expressiveness can matter more than eliminating every last duplication.

### YouArentGonnaNeedIt

"Always implement things when you actually need them, never when you just foresee that
you need them." Even if you're totally sure you'll need a feature later on, don't
implement it now. Usually, it'll turn out either (a) you don't need it after all, or
(b) what you actually need is quite different from what you foresaw.

Ron Jeffries on why: "You can't 'save' time by doing the work now, unless it will take
more time to do it later than it will to do now. So you are saying: 'We will be able to
do less work overall, at the cost of doing more work now.' But unless your project is
very different from mine, you already have too much to do right now."

Kent Beck: "YouArentGonnaNeedIt is not the same as forgetting experience, acting stupid,
or abandoning morals. It is a challenge to developers to abandon their fears of a
far-flung future that may never happen and do an absolutely stellar job of solving
today's problems today. Actually, when I violate this rule, it is typically because I
am overwhelmed by my fears of not being good enough for today's task. Solving tomorrow's
problem is an excellent avoidance strategy, because you can't be proven wrong."

YAGNI works because other XP practices back you up:
- CollectiveCodeOwnership: you can change anybody's code later
- RefactorMercilessly + OnceAndOnlyOnce: makes it easier to add functionality later
- UnitTests: ensure added functionality won't break past functionality

So if you do need to implement it in the future, it probably won't be much harder.

### DoTheSimplestThingThatCouldPossiblyWork

Often misunderstood. Ward Cunningham clarified: "I think the advice got turned into a
command... That's more confusing, because there isn't this notion that as soon as you've
done it, we'll evaluate it."

The original intent was: when you're not sure what to do, try the simplest approach,
look at it, and evaluate. It's a tactic for breaking through analysis paralysis, not
a license to be lazy. You still evaluate after.

---

## Code Smells

A code smell is a hint that something has gone wrong somewhere in your code. Use the
smell to track down the problem. Kent Beck coined the phrase, saying code "wants to be
simple."

A CodeSmell is a hint, not a certainty. A perfectly good idiom may be considered a smell
because it's often misused, or because there's a simpler alternative. Calling something
a smell is not an attack — it's a sign that a closer look is warranted.

### Key smells to watch for in review

**Too much code — take something off the stove:**
- DuplicatedCode (the strongest smell)
- Methods too big (see ComposedMethod)
- Classes with too many instance variables
- Classes with too much code (OneResponsibilityRule)
- Strikingly similar subclasses
- An instance variable that is only set in some circumstances
- Code not actually ever used (YouDontNeedItAnymore)

**Not enough code — half-baked:**
- Classes with too few instance variables or too little code
- Empty catch clauses
- Explicitly setting variables to null everywhere

**Structural smells:**
- FeatureEnvy — many messages to the same object from the same method (MoveMethod)
- LawOfDemeter violations — messages to the results of messages
- ShotgunSurgery — same rate of change in different, disconnected objects
- Sporadic ChangeVelocity — different rates of change in the same object
- Long method names (often indicates the method is in the wrong class)
- PrimitiveObsession — using strings/ints where a ValueObject would be clearer
- DataClumps — groups of data that always travel together

**The nose test:** "I think my major problem with the terminology is that it
complicates critiques." The smell metaphor works because smells are indirect — they
indicate something, somewhere needs attention, but they don't tell you exactly what.
Start hunting.

---

## OnceAndOnlyOnce

One of the main goals when refactoring code. Each and every declaration of behavior
should appear OnceAndOnlyOnce. Conceptually analogous to normalization in the relational
model.

Kent Beck: "Code wants to be simple. If you are aware of CodeSmells, and duplicate code
is one of the strongest, and you react accordingly, your systems will get simpler. When
I began working in this style, I had to give up the idea that I had the perfect vision
of the system to which the system had to conform. Instead, I had to accept that I was
only the vehicle for the system expressing its own desire for simplicity."

**Beware:** Introducing unnecessary coupling just to remove duplication is not a net win.
The cure can be worse than the disease when you couple unrelated concepts just because
they happen to look similar right now. See also ThreeStrikesAndYouRefactor.

Sandi Metz's corollary: "Duplication is far cheaper than the wrong abstraction." If
you've extracted a shared function and it needs boolean parameters or type-checking to
handle its callers differently, you've created coupling that makes both callers harder
to change. The right move is often to inline the abstraction back, tolerate the
duplication, and wait until the real pattern reveals itself. Premature deduplication —
acting on duplication before you understand why things look similar — is itself a smell.

### ThreeStrikesAndYouRefactor

From Fowler's Refactoring book:
- The first time you do something, you just do it.
- The second time you do something similar, you wince at the duplication, but do it anyway.
- The third time you do something similar, you refactor.

You especially want to apply this when the first two cases aren't enough to really
understand what is common and what is unique about the uses.

---

## Refactoring

### RefactorMercilessly

When you find two methods that look the same, refactor to combine them. When you find
two objects with common functionality, refactor to make there be just one.

The result is that every bit of knowledge is found in just one place. Refactoring
combined with unit tests lets you improve design continuously with confidence.

RelentlessTesting and ContinuousIntegration permit changes that would introduce the
risk of bugs in slower projects.

Key insight: you don't need BigDesignUpFront if you refactor continuously. The design
emerges and stays clean.

---

## Composed Method & Naming

### ComposedMethod (Kent Beck, Smalltalk Best Practice Patterns)

"Divide your program into methods that perform one identifiable task. Keep all of the
operations in a method at the same level of abstraction. This will naturally result in
programs with many small methods, each a few lines long."

Rule of thumb: if your description of what the method does includes the word "and",
that's probably two methods.

### IntentionRevealingMethodName / SelfDocumentingCode

Name things so well that comments become unnecessary. When you're tempted to write a
comment, first try:
- Rename the variable/method to express the intent
- Extract a method with a name that says what it does

The code should read like well-written prose at each level of abstraction.

---

## Tell Don't Ask & Law of Demeter

### TellDontAsk

It is okay to use accessors to get the state of an object, as long as you don't use the
result to make decisions outside the object. Any decisions based entirely upon the state
of one object should be made inside the object itself.

A sibling to the LawOfDemeter. The Law is about loose coupling; TellDontAsk is about
allocating responsibility. It's a good way to avoid FeatureEnvy.

### LawOfDemeter

Only talk to your immediate friends. Don't reach through an object to get to another
object to do something. If you're chaining method calls through several objects, you
have a coupling problem.

---

## Test-Driven Development

When you code, alternate these activities:
1. Add a test, get it to fail, and write code to pass the test
2. Remove duplication (OnceAndOnlyOnce, ThreeStrikesAndYouRefactor)

"Using this system, all my code is highly decoupled because it all already has two
users — its clients, and its test rigs. Classes typically resist the transition from
one user to two, then the rest are easy. I make reuse easy as a side-effect of coding
very fast."

The "remove duplication" phase forces one to examine code for latent abstractions that
one could express via virtual methods and other techniques. This is where design
happens in TDD — not up front, but as a natural consequence of eliminating duplication.

---

## Technical Debt

During planning or execution, decisions are made to defer necessary work:
- It's too late to upgrade to the new compiler release
- We're not completely conforming to the interface guidelines
- We don't have time to refactor the widget code

A big pile of deferred work can gum up a project, yet many items don't appear on the
team's radar. Make the debt visible. Keep an explicit TechnicalDebtList. Group deferred
tasks into workable units, note the consequences of leaving each unattended.

Ward Cunningham's original metaphor: shipping first-time code is like going into debt.
A little debt speeds development so long as it is paid back promptly with a rewrite.
The danger occurs when the debt is not repaid. Every minute spent on not-quite-right
code counts as interest on that debt.

---

## Premature Optimization

"Programmers waste enormous amounts of time thinking about, or worrying about, the
speed of noncritical parts of their programs, and these attempts at efficiency actually
have a strong negative impact when debugging and maintenance are considered. We should
forget about small efficiencies, say about 97% of the time: premature optimization is
the root of all evil." — Donald Knuth

PrematureOptimization can be defined as optimizing before we know that we need to.
Optimizing up front often breaks YAGNI. But by the time we decide we need to optimize,
we might have UniformlySlowCode that's hard to fix.

Balance: profile first, optimize the hot path, leave the rest clear and simple.

---

## The Source Code Is The Design

A traditional manufacturing cycle has a design phase and a manufacturing phase. In
software, the programming activity IS the design phase, while compilation is the
(practically free) manufacturing phase.

Many have insisted on treating programming like manufacturing. But TheSourceCodeIsTheProduct
is an illusion. The source code is actually the design document. This insight explains
why heavyweight design-before-coding processes fail — they're designing the design, one
level of indirection too many.

This means: the code IS the design. If the code is messy, the design is messy. If the
code is clean, the design is clean. There is no separate "design" that can be good while
the code is bad.
