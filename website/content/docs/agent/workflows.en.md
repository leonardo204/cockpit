A single message can be more than one command. If you start several lines with `/` or `@`, Cockpit reads the whole message as an **ordered workflow** — each command line is a step, and Cockpit assembles them into one numbered plan before the AI starts. It's the fastest way to say "clarify this, then fix it, then have a sub-agent review the fix" without sending three separate messages.

This builds directly on the [slash menu](/en/docs/agent/message-input/#slash-menu-) and [Skills](/en/docs/agent/skills/) — the same commands, now chainable.

## One message, several steps

Each line that starts with a known command becomes a step:

| Marker | Where the step runs |
|---|---|
| `/verb` | the **main session** — the AI continues in the current chat |
| `@verb` | a **sub-agent** — Cockpit delegates the step to a separate agent and reports back |

`verb` is any built-in command (`/qa`, `/fx`, `/cr`, …) or any [installed skill](/en/docs/agent/skills/#custom-skills) of the same name. A verb starts with a letter and may contain letters, digits, and hyphens — so `/new-branch` and `/qa` are both single commands.

Here's a three-step message:

```text
Here is the failing test output: payment webhook 500s on retries.
/fx
figure out why the idempotency key isn't being honored
@cr
audit the fix for race conditions and missing rollbacks
```

Cockpit turns that into a single ordered prompt — roughly:

```text
Here is the failing test output: payment webhook 500s on retries.

Complete the following steps in order:

Step 1 (run in the main session): 
Please read this skill file:
~/.cockpit/skills/fx/SKILL.md
Question: figure out why the idempotency key isn't being honored

Step 2 (run in a subagent): 
Please read this skill file:
~/.cockpit/skills/cr/SKILL.md
Question: audit the fix for race conditions and missing rollbacks
```

You write four lines; the AI receives a structured plan it works through in order.

## How a message is split into steps

The rules are line-based and predictable:

- **A command line** is any line whose first non-space character is `/` or `@` followed by a known verb. Lines that start with a slash but aren't a real command (`/usr/local/bin`, `@mention`) are left as ordinary text.
- **A step's body** is everything after the verb on that line, plus every following line, up to the next command line. Blank lines and multiple paragraphs are kept — so a step can carry as much context as you want.
- **Preamble** is any text *before* the first command line. It's passed through as-is at the top of the plan — a good place to paste an error log or describe the goal once for the whole workflow.

## Main session vs sub-agent — `/` vs `@`

- `/verb` keeps the work **in the current chat**. Use it for steps you want to watch and steer turn by turn.
- `@verb` hands the step to a **sub-agent**. Use it for self-contained work — a review pass, an exploration, a focused investigation — that you want done and summarized without cluttering the main thread.

A common shape is "do the work in the main session, then send a sub-agent to check it":

```text
/go
implement the retry backoff described in the ticket
@cr
review what was just written for correctness and style
```

## Built-ins and your own skills, mixed

A workflow can freely mix [built-in commands](/en/docs/agent/skills/) and your [installed skills](/en/docs/agent/skills/#custom-skills) — they resolve through the same "read this SKILL.md" path. If a skill you installed shares a name with a built-in, **your skill wins**: a `/cr` you authored shadows the built-in `/cr`, so your edits always take effect.

## Autocomplete follows your cursor

The command menu no longer triggers only at the very start of the box. Type `/` or `@` at the start of **any line** — including the second, third, or fourth — and the autocomplete dropdown appears for that line, filtered as you type. `Tab` or `Enter` inserts the selected command. That's what makes stacking commands line by line comfortable.

## When it stays a single command

If your message is just one `/verb` with no preamble and no `@`, nothing changes — you get the original compact behavior: the command's skill plus your trailing text, sent as one normal turn. The numbered step list only appears when there's genuinely a workflow to run: two or more commands, any `@` sub-agent step, or leading preamble text.

## Next

- [Skills](/en/docs/agent/skills/) — the built-in commands and how to install your own
- [Message Input](/en/docs/agent/message-input/) — everything else the message box does
- [Sessions](/en/docs/agent/sessions/) — running multiple chat tabs
