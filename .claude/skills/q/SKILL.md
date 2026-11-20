---
name: q
description: The owner's priority queue for BC work in this board. Shows the inbox of cards waiting on the owner, loads one card so they can decide on it, records their decisions on the card, runs the agent steps of cards in agent state, and pulls their Development work items for the current iteration from ADO into cards. Use when the owner says /q, "what's next", "next item", answers a card's questions by number, asks to add a work item to the queue, asks to pull or sync the iteration, sets the current iteration, or asks to run a cycle.
---

# Queue

The board is the folder two levels above this skill (`<board>\.claude\skills\q`); below, `<board>` means that path. Read its `README.md`, `FAQ.md` and `config.json` once per session. `FAQ.md` holds the states, action types, priority and the repo-copy rule. `config.json` names the owner and says which optional parts are on: `harvest`, `repoCopies`, `objectIds`. A part that is off is skipped wherever this skill mentions it.

The owner usually reads and rules in the local app (http://localhost:4747); chat is the other way in. The app records decisions and simple card changes itself. It runs pull, add and sync as headless `from-app` jobs, and opens a terminal window with `/q cycle`, `/q cycle <id>` or `/q <id>`; a session in such a window works exactly like one in chat. Cards are in `cards\<id>.md`. `INBOX.md` is generated; never edit it by hand.

Rebuild the inbox after every card change:

```
powershell -NoProfile -File <board>\scripts\Get-Inbox.ps1
```

`-Check` validates without writing. Report its warnings; a branch mismatch means the card or the repo copy is wrong, so ask which.

Then commit the card and `INBOX.md` together, one commit per card change:

```
git -C <board> add -- cards/<id>.md INBOX.md
git -C <board> commit -q -m "<id>: <where the card went>" -- cards/<id>.md INBOX.md
git -C <board> push -q origin main
```

Push only when the board has a remote (`git -C <board> remote` lists `origin`). If the push fails, keep the commit, say so in one line, and push again with the next commit. Never force-push.

Write card text with the Edit tool, or Write for a new card, never from the shell (python or node heredocs, `sed -i`, `cat >>`): hooks read a shell command's whole text and can block a card write that names a script or URL. Keep the shell for the inbox, git and the scripts.

Name the files, never `add -A` or `commit -a`: an `add -A` once swept uncommitted app code into a card commit. Add to both lists any other board file this card's change wrote itself, such as `ids.json` (object IDs) or `ado.json` (iteration, pull). Anything else still changed in the board belongs to someone else, the app or another session: leave it out of the commit and name it in one line.

One lowercase line, such as `9383: go on slice 1, to agent`, with no attribution lines.

## Commands

1. `/q` or `/q show`. Rebuild, then give the top five "Waiting on you" lines and any warnings. Nothing else.
2. `/q next` or `/q <id>`. Load one card, by default the top one:
   - Check the live state first: with repo copies on, the branch and dirty count in its repo copy; the ADO state; the PR status if `pr` is set. If anything changed since `updated`, fix the card's "Now" and say what changed in one line.
   - Then give "Now" and the numbered questions as they stand on the card. Nothing from other cards.
   - The owner should be able to decide without opening another file. If a question needs code to judge, put the file:line link in the card's Evidence, not only in chat.
3. Decisions. When the owner answers by number ("1 A, 2 B, 3 fix it"):
   - Append to Decisions: date, then their words quoted, then what each answer means.
   - Remove answered questions from "Waiting on you".
   - Set `state`, `action`, `next_step` and `updated`. A go moves the card to `agent` with `next_step` naming that one step. Anything the owner must do themselves stays `you` with `action: unblock`. Waiting on someone else becomes `parked` with a `revisit` date. A change that is done and waits only on code review of its open PR becomes `review` with `pr` set, `action` and `next_step` none; review comments or a requested change send it back to `you`.
   - If the owner answers with a question or "not sure", the question was wrong. Rewrite it and add 1 to `bounces`.
   - Rebuild the inbox. Then say in one line where the card went, and stop. Don't start the next card unless asked.
4. `/q cycle`. First settle the `decided` cards, then run the `next_step` of each `agent` card, oldest first:
   - A `decided` card got its answers in the app (`app\server.js`). Its newest Decisions entry, headed "from the app", holds each answered question with the option picked ("Decided B: ...") and the owner's notes quoted ("<owner>: ..."). Treat it as a decision in chat (step 3): add one line under the entry saying what it means, then set `state`, `action`, `next_step`. Questions still under "Waiting on you" were left unanswered: if any remain and nothing else moves the card, it goes back to `you`. A note that asks a question or says "not sure" is a bounce.
   - Screenshots. The owner pastes them on a card in the app. Each one is a `- Screenshot:` line in a Decisions entry with its absolute path in backticks and the caption quoted after it, and the file sits in `<board>\attachments\<id>\`. Before you settle a card or run its step, open every screenshot named in the entries since the card last came back to the owner with Read. Treat them as part of the answer. List their paths in the agent brief under "Screenshots from the owner" so the agent opens them too. They are committed with the card, so never move or delete them.
   - A `decided` card that becomes `agent` gets its step in this same cycle.
   - At most one board-planner step per cycle: several planners at once broke alc.exe. The oldest card gets the slot. A card that misses out keeps `state: agent` and its `next_step` and goes first next cycle. board-implementer and board-reviewer steps have no cap and may run side by side.
   - Say in one line which cards and steps you'll run before starting, and which wait for the cap.
   - Before starting each card's step, run `node <board>\scripts\limit-check.js <agent>` with the board-* agent the step runs, or no argument for main-session work. It prints `go: ...` or `stop: ...`. On `stop` (exit 1), start nothing yet and ask the owner with AskUserQuestion, quoting the reason it printed and naming the card and step: A) continue with this step, B) continue for the rest of this cycle, C) stop here. On A, run the step and ask again at the next `stop`. On B, keep running the gate before each step, but don't ask again this cycle. On C, start no further steps, let the running ones finish, and end the cycle with one line naming the cards that wait and the reason it printed. When A or B was chosen, the closing summary says which steps ran past the gate and the last reading it printed. While the question waits, the app's job lock holds and the board takes no writes.
   - With repo copies on: before each step, check that the card's repo copy is on the card's branch. If not, skip the card and add a warning question to it.
   - With repo copies on: a card with `repo: none` takes a copy before its first step, the first free one by name. Free means no open card claims it, it is clean, and it is on the base branch, `baseBranch` in `ado.json` (always read it from there). `Get-Inbox.ps1 -Json` marks such a copy `Free`. If none is free, take the first clean copy with no card, `git fetch` and `git switch <baseBranch>` there, and say so in one line. If every copy is dirty or claimed, skip the card and add a question. Write `repo` and `branch: <baseBranch>` on the card.
   - With repo copies off, the card's step works in the repository the card or its Decisions name; ask on the card when none is named.
   - New work branches from `origin/<baseBranch>`, and only after a decision for that branch.
   - Run the step with the board's agents: board-planner, board-implementer and board-reviewer. Small work (a fix that stays in existing objects, with no new object and no schema change) may run in the main session. ADO calls stay in the main session.
   - Object IDs: with `objectIds` on, tell board-implementer in the brief that the board assigns object IDs, so it declares new objects with ID `0`; the board's PostToolUse hook (`scripts\assign-ids.js`) assigns them when it returns. Then rebuild the copy and put the IDs it reports under Evidence. A `0` it couldn't assign goes under Waiting on you. With `objectIds` off, the agent reserves IDs itself.
   - Put the card's full path in every agent brief, and the repo copy's path. Each board-* agent then ends its report with a `For the card` block. board-reviewer also reads the card, so finding IDs stay stable across rounds.
   - Save the reviewer's diff where the next session finds it (a folder the card's Evidence names), not the scratchpad, so the Evidence link still works next session.
   - Write the `For the card` block onto the card. Rewrite "Now", replace "Waiting on you" with the new questions, and add to Evidence. If an agent left the block out, build it from its report and say so. Then set the card to `you`.
   - Test list. When board-reviewer approves the final round (no blockers left), write `## Test list` on the card in the same cycle, above `## Time`. One `- [ ] ` line per test: what to do and the expected result, on one line, from the work item's requirements, the diff, and review findings as tests or as a "not a failure" known limitation. Create no test data; a line names the data it needs. Never rewrite or reorder lines that are there, and never touch `[x]`: the owner ticks them in the app.
   - The planner's solo estimate goes in `solo_estimate` as the total range in hours (`6-10`), and its phase lines replace the body of `## Time`. A card with no estimate yet after any step gets one from you, marked with an asterisk, in the same shape.
   - Run `node <board>\scripts\card-time.js --mark <id> start` right before a card's step and `... --mark <id> end` right after it, failed steps too. The marks keep the step's time on the card when a transcript goes missing.
   - One step per card per cycle. Stop when every card has had its step.
   - The cycle's last action, after the board's commit and push, also when the gate stopped it: `node <board>\scripts\card-time.js --done <one line>`, the line being the cycle's closing summary (what moved, what waits and why). In a window the app opened, the app then closes the window if the board is clean and shows that line. Outside the app it does nothing.
   - `/q cycle <id>` does the same for that one card only: settle it if `decided`, then run its step if `agent`. The app's "Run next step" button opens it in a terminal window.
5. `/q add <id>`. Read the work item from ADO (expand all, comments), copy `cards\_template.md`, fill it in, and set the first question. `ado_prio` comes from `Custom.Prioritet` ("3 - High" is 3, empty is 1).
   - `/q add <id> from-app`: the app's Add box runs this headless with ADO reads and edits to `cards/` and `ado.json` only. The board is the working directory. Write the card and nothing else: no inbox rebuild, no git, no other card. The app commits. End with one line.
6. `/q sync`. Refresh `ado_state` and `pr` on every open card from ADO. A closed work item with a merged PR moves to `done`. Report what moved.
   - With `harvest` on: `list_time_entries` from January 1 of the first year in `ado.json` `years` to today, every page, with `limit` 100. An entry belongs to a card when its notes hold the card id as `CR<id>` or `#<id>` (the whole number, so `CR93` doesn't match 9383). Per open card set `harvest_logged` to the summed hours with one decimal (`0` when none) and `harvest` to `<project> / <task>` with the most hours (`none` when none). Change the fields only when the value differs, so an unchanged card isn't committed. With `harvest` off, leave both fields alone.
   - Each sync writes `lastSync` in `ado.json`: `{ "at": "yyyy-MM-dd HH:mm", "changed": [ids], "done": [ids] }`, ids as strings. The app reads it. From the app, `at` can be today's date alone; the app sets the time.
   - `/q sync from-app`: the app's Sync button runs this headless with ADO reads, pull request reads, Harvest time entry reads when on, and edits to `cards/` and `ado.json` only. The board is the working directory. Change only `ado_state`, `pr`, `state` (to `done`), `harvest`, `harvest_logged` and `updated` on cards, write `lastSync`, and nothing else: no inbox rebuild, no git. The app commits each changed card. End with one line.
7. `/q pull`. Make cards for the work items in the current iteration that are in Development. `ado.json` in the board holds the area, the years, the current `iteration` and the cached iteration list. The app's Pull button runs this as `/q pull from-app` (see below).
   1. Refresh the list: `work` list_iterations, project Core, depth 4. Keep the leaves under `Forvaltning\<year>` for each year in `years`. Write them to `iterations` as `{ path, start, end }`, with paths the way work items carry them (`Core\Forvaltning\2026\25.3 - Desember`: no `\Iteration`, no leading `\`) and dates as yyyy-MM-dd. Set `listed` to today. Never change `iteration` here; if it is empty or no longer in the list, stop after writing the list and say so (on a new board, the first pull only fetches the list).
   2. WIQL in project Core: `[System.AssignedTo] = @Me AND [System.AreaPath] UNDER '<area>' AND [System.IterationPath] = '<iteration>' AND [System.State] = 'Development'`.
   3. Each id without a `cards\<id>.md` gets a card, built the way `/q add` builds one. `ado_state` is Development, `repo` and `branch` are none, `state: you`, `action: decide`. The only question:
      ```
      1. Start on this one?
         - A: Yes. The card goes to `agent` and the next cycle runs the planning step.
         - B: Not now. The card is parked; put the revisit date in a note.
      ```
   4. Open cards with `ado_state: Development`: get_batch their `System.State`. Those no longer in Development go in `left`. Don't change those cards; `/q sync` does that.
   5. Write `lastPull`: `{ "at": "yyyy-MM-dd HH:mm", "iteration", "found": [ids], "added": [ids], "had": [ids], "left": [{ "id", "state" }] }`, ids as strings.
   6. In chat: rebuild the inbox, then one commit per new card (`<id>: pulled from <leaf>, to you`, only that card's file), then one commit for `ado.json` and `INBOX.md` (`pull <leaf>: added <ids>` or `pull <leaf>: nothing new`), then push. Report added, already carded and left Development, one line each.
   7. `from-app`: the app runs this headless with a fixed tool list, ADO reads and edits to `cards/` and `ado.json` only. The board is the working directory. Do steps 1 to 5 and nothing else: no inbox rebuild, no git, no edits to existing cards, no agents. The app commits afterwards. End with one line naming the added ids.
8. `/q iteration [name]`. Without a name, list the iterations in `ado.json` with the current one marked. With a name, match it against the leaf names (`25.4` is enough), set `iteration`, commit `iteration: <leaf>` and push. The app's dropdown does the same.

## Never

1. Commit, branch, push, open a PR or write to ADO in a BC repo unless Decisions holds a go for that exact write. A go for one step doesn't cover the next. The board repo's own commits are the one exception.
2. Put open loops in memory. They go on a card. Memory keeps facts.

## Style

Short and numbered. Asterisk anything inferred. "Now" holds enough to decide without opening ADO: short paragraphs led by **Problem.** (what is wrong or wanted, for which customer, in the work item's terms), optionally **The fix.** or **The proposal.**, then **Where it stands.** (branch, PR, review round, what's committed) and **What your answers unlock.** (the step a decision starts). Rewrite it rather than appending. Code the questions point at goes in the question as a file:line link; the app shows the snippet. One question per review finding (B, Q, S and N alike); never group findings into one question, since grouped findings can't be answered one by one.
