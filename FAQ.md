# FAQ

What the board's states, tags and buttons mean, and the rules behind them. The app shows this page under the ? button. `README.md` covers how the board and the app are set up.

## What do the states mean?

- `you`: waits on you. The action chip says what kind of answer.
- `decided`: you answered in the app. It waits for the next `/q cycle` to read your answers and set the next state.
- `agent`: Claude can move it. `next_step` on the card names the one step it may take.
- `review`: done on your side, waiting on code review of the PR in `pr`. Not done yet, but nothing to do until the review comes back.
- `parked`: waits on someone else. `revisit` is the date to look again.
- `done`: kept for history. It leaves the board.

## What do the action chips mean?

- `decide`: a plan decision, or review findings by their B/S/N ID.
- `go`: approve one named step. A go covers that step only, never a commit, PR, branch or ADO write.
- `test`: run it in the feature env and report back.
- `explain`: your 5-minute summary before a commit.
- `draft`: you write the first pass, for a concept that's new to you.
- `unblock`: something only you can do, such as unlocking tests, Set-BcSecrets, an allow rule, VPN or a reviewer in ADO.

## What do the other chips on a card mean?

- `unblocks agent`: answering this lets an agent step run. These cards sort first.
- `Low`, `Medium`, `High`, `Urgent`: the work item's priority in ADO (`Custom.Prioritet`).
- `3 d · 2 questions`: days since the card last changed, and how many questions wait on it. The list shows the first question.
- `bounced 2x`: the same question came back twice. Rephrase it or park the card.
- State chip at the top of a card (`YOU`, `DECIDED`, `AGENT`, `REVIEW`, `PARKED`): the card's state.
- `Development · High`: the work item's ADO state and priority.
- The repo and branch chips: the repo copy the card works in, and its branch.
- `Work item`, `PR 13541`: open the work item or pull request in ADO.
- The date chip: when the card last changed.

## What are B1, Q1, S1 and N1?

Review findings, by level:

- `B` blocking: a wrong result on a case the spec covers.
- `Q` question: confirm that a behaviour change is intended.
- `S` should fix: a runtime effect outside the spec's cases.
- `N` nit: no runtime effect.

A problem that predates the change or lies outside the scope gets a level the same way, marked `(pre-existing)` or `(out of scope)`. Cards reviewed before 2026-11-17 used S and N by priority and have no Q. The number stays the same across review rounds, so `S1` in round 4 is the same finding as `S1` in round 2.

## Why is a card higher in the list than another?

`Get-Inbox.ps1` sorts the cards waiting on you by:

1. Your own order. Drag a card up or down in the list and the app saves the order in `order.json` and commits it. It overrules the rules below. A card you haven't placed, such as a new one, comes after the ones you have, sorted by those rules.
2. `blocks_agent: yes`. A decision that frees an agent step costs little and frees a repo copy.
3. `prod: yes`. The app no longer shows it, since everything here goes to production, but cards that have it still sort higher. Edit… sets it.
4. ADO priority, Urgent down to Low.
5. Oldest change first.

## Which repo copy does a card get?

Only with `repoCopies.enabled` in `config.json`. The copies are the folders under `projectsRoot` whose names match `repoCopies.pattern` (`BC25_*` by default), each a checkout of its own. With copies off, cards keep `repo: none` and this section doesn't apply.

Neither you nor chance: a fixed rule in the `/q` skill. A new card starts with `repo: none`. Before its first agent step, the cycle takes the first free copy by name.

A copy is free when no open card claims it, it has no uncommitted changes, and it is on the base branch. The base branch is `baseBranch` in `ado.json`. It will change, so the rule always reads it from there.

If no copy is free, the cycle takes the first clean copy with no card, switches it to the base branch, and says so. If every copy is dirty or claimed, the card waits with a question. The cycle writes the copy and the base branch on the card.

New work branches from `origin/<baseBranch>`, and only after you rule a go for that branch. You can also set the copy yourself with Edit….

## What do free and idle mean under Repo copies?

- A card number: that card holds the copy. One copy holds one card.
- `free`: no card, clean, and on the base branch. A new card can take it.
- `idle`: no card, but not ready for a new one. Hover it to see why: it's on another branch, or it has uncommitted changes.
- `3 dirty`: files with uncommitted changes.

## What do the warnings mean?

`Get-Inbox.ps1` checks every card. The usual ones:

- A card's repo copy is on another branch than the card says. The card or the copy is wrong; the cycle skips the card until it's fixed.
- A copy is claimed by two cards.
- A card is missing a field, has an unknown state or action, or is `you` without a numbered question.
- `parked` without a revisit date, `agent` without a next step, or `review` without a PR.

## What do the header buttons do?

- The counts: cards waiting on you, decided, with the agent, in review and parked, plus warnings when there are any.
- Tests: whether Claude may edit the unit-test app (core-bc-al-ext/unit-tests). Locked unlocks it for 4 hours; Open until 14:30 locks it again. It runs `~/.claude/scripts/Allow-TestEdits.ps1`, and one unlock covers every repo copy. Claude can't call it, since the protect-tests hook blocks any command with the unlock script's name in it. Shown only when you have that script and hook; the template doesn't include them.
- The iteration dropdown: the current iteration, which Pull uses.
- Pull: makes cards for your Development work items in that iteration. Runs Claude headless.
- Work item # and Add: makes a card for one work item.
- Sync: refreshes ADO state and PR on every open card. A closed work item with a merged PR moves to done.
- Cycle: opens Claude Code (Opus) in a terminal with `/q cycle`. First it reads the answers on decided cards and moves each card on. Then it runs the one step named on each agent card, oldest first, such as planning, building or review; with repo copies on, a new card first takes a free repo copy. Each result goes on its card, usually as new questions for you. One step per card per cycle, and never a commit, branch, push or ADO write in a BC repo without your decision for it. At most one planning step per cycle; other cards with planning steps wait for the next. Before each step the cycle checks the usage limits. When the 5-hour window would pass 95% (85% until it has been measured) or the week is at 95%, it asks you whether to go on with that step, go on for the rest of the cycle, or stop. Before it starts, the app shows what it will likely use. When the cycle is done and the board is clean, the app closes its window and shows its summary; with changes left the window stays open.
- Refresh: rereads the cards and repo copies.
- ?: this page.

Only one job runs at a time. While one runs, every other write waits.

## What do the buttons on a card do?

- Run next step: `/q cycle <id>` in a terminal, for this card only. Shown on `agent` cards.
- Settle and run: the same on a `decided` card. It reads your answers, moves the card on, and runs the step if the card goes to the agent.
- Screenshots: Ctrl+V on a card pastes a screenshot, with an optional caption. It is saved with Record decisions, or on its own with Save now. The file goes in `attachments/<id>/`, committed with the card, and Decisions names it by path. The cycle opens it and hands the path to the agents.
- Test list: written by the cycle when the final review approves, one checkbox per test, shown between Screenshots and Release note. Ticks are a draft in this browser, like your picks on questions, until Save ticks writes them to the card in one commit. They add nothing under Decisions.
- Release note: shown between Screenshots and Time when the card has a `## Release note` section, which you or your own wrap-up step write. Copy puts the text on the clipboard, ready to paste under `## Release Notes` in the PR.
- Open in Claude: `/q <id>` in a terminal, to talk about the card.
- Back to you, In review…, Park…, Done: change the state directly, with a dated line under Decisions. Back to you shows on parked, review and done cards. In review… asks for the PR number and, optionally, who reviews it, and writes them to the card's `pr` and `reviewer`. The sidebar shows both, and the PR number opens the PR in Azure DevOps.
- Re-open: on decided and agent cards. Takes back your last decision from the app, so its questions come back as they were before it, the Decisions entry goes, and the card waits on you again. Greyed out while a cycle may be working on the card; hover it for the reason.
- Edit…: title, priority, production, repo copy, branch, next step and revisit date.
- Record decisions (Ctrl+Enter): saves your answers. Unanswered questions stay on the card.
- Draft: every pick and note is kept in this browser as you make it, so the FAQ, another card or a reload doesn't clear them. A draft isn't committed and doesn't move the card to the cycle; only Record decisions does. An answer is dropped if a cycle has rewritten its question since.

Every change is one commit in the board repo, pushed to its `origin` remote when it has one.

## What does the Time panel show?

Hours for the whole work item, to help you fill in Harvest.

- Solo estimate: how long the change would take you without Claude. board-planner sets it, by phase, and re-estimates when the scope changes. It's there to compare with, not to log.
- Claude: time Claude spent working on the card, read from the transcripts in `~/.claude/projects`. A transcript counts when it's on the card's branch (`cr/<id>_...`), started with `/q <id>`, `/q cycle <id>` or `/q add <id>`, or is an agent whose brief names the card. Gaps over 10 minutes are left out, and parallel agents count once. The main thread of a `/q cycle` over all cards counts for no card; its agents do.
- You in sessions: the time between Claude's replies and your next prompt in those transcripts, with the same 10-minute cap. Your testing, review and reading outside sessions isn't in it.
- No transcript: app windows and cycle steps for the card whose transcript is missing, so the time can't be split between you and Claude. The app logs its windows and the cycle logs its steps in `app/jobs.jsonl` for this.
- Harvest, only with `harvest` on in `config.json`: the hours logged on entries whose notes say `CR<id>` or `#<id>`, and the project and task with the most hours. `/q sync` reads them.
- The line under it says how much more to log: at least your session time, plus your own work outside sessions.
- Claude, You in sessions and No transcript are in half hours, the way Harvest is logged, with the measured minutes beside them. Each day's minutes on the card are rounded on their own: whole half hours count, and what is left over counts as another half hour from 10 minutes (8 min is 0, 12 min 0.5 h, 35 min 0.5 h, 42 min 1.0 h). Time past midnight counts on the next day.

## What is the bar at the bottom?

- Usage: your Claude limits, the 5-hour window and the week, with reset times. Above 80% of the 5-hour window or 90% of the week, every Claude job asks before it starts. Numbers older than 30 minutes trigger a one-word Haiku probe; the refresh button runs one now.
- Code: shows or hides the code pane. Hidden, a code link slides the pane in over the card.
- Theme: the colours. Made here dark, Made here light, Popular dark and Popular light (generated by `scripts/popular-themes.js`).

## How do I resize the columns?

Drag the edge between the list and the card, or between the card and the code. Double-click an edge to put it back. The widths, the theme and the Code setting are kept per browser.
