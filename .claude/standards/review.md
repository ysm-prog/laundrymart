# Review Standard

Applies to any review: code, architecture, security, accessibility, tests, or a change of any kind.

## Establish the project's position first

- Read the project's own instructions and its existing skills for the area before reviewing it. A project that has already decided something is not making a mistake you have just discovered.
- Check whether the concern is already recorded as known and accepted. Re-raising a logged decision as a new finding wastes the reader's attention and makes the rest of the report less trusted.
- Where the project's rules are more specific than a general standard, review against the project's rules and say so.

## Confirm before reporting

- Treat a search result as a candidate, not a finding. Read the surrounding code before it becomes either.
- A pattern that appears absent may be expressed another way. The absence of one mechanism is not evidence of a defect until you have checked for the alternatives that would also be correct.
- A match inside a comment, a string, a test fixture, or generated output is not the code doing that thing.
- A repository-wide count can hide the place that differs. Confirm that a summary figure holds where it matters most before reporting it as a pattern.
- Say which findings you verified and which you inferred. An unverified suspicion is worth reporting only when it is labelled as one.
- Report that something is sound when it is. Manufacturing findings to appear thorough costs more attention than it saves.

## Rank by who is affected

- Establish the audience and the scale before assigning severity: who touches this surface, how many of them, and whether they are the public or a handful of internal staff.
- Separate what prevents someone completing a task from what makes it harder. The first is a blocker at any scale.
- Distinguish a defect that is live from one that is latent — real in the code but not reachable until some future condition. Say which it is rather than ranking both at the top.
- Judge severity by consequence, not by how alarming the category sounds.
