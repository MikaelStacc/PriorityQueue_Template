# Priority queue

A board for BC work with Claude. One card per open loop, in `cards/`. `INBOX.md` is generated from the cards and lists what waits on you, sorted.

The cards are the record. Chat and memory are not. If a session dies, the card still says where the work stands.

Started from the template at Stacc. Your copy is yours: change it as you like.

## Set up

You need Node.js, git, Windows PowerShell and Claude Code (`claude` on PATH), with the Azure DevOps MCP server (`azure-devops`) connected.

1. Clone the template to where you want your board, for example `git clone https://github.com/MikaelStacc/PriorityQueue_Template.git C:\Projects\PriorityQueue`.
2. In your own terminal, in that folder:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -Owner "Your Name" -Startup
   ```
   It writes your name into `config.json`, renames the template's `origin` remote to `template` (so your cards are never pushed to the template), builds the inbox and commits. `-Startup` adds a shortcut that starts the server hidden at logon. Later, `git pull template main` brings template updates.
3. Open `config.json` and switch on what you use (below).
4. Run `app\start.cmd`. The app opens at http://localhost:4747.
5. Press Pull once: on a new board it fetches the iteration list. Pick the current iteration and Pull again.
6. To keep the board's history somewhere else, add a remote named `origin`. The app pushes after every commit once it has one.

## config.json

- `owner`: your name. Your notes on cards are quoted under it.
- `projectsRoot`: the folder your checkouts live in. The code preview reads only files under it.
- `edgeAppId`: empty opens the app in your default browser. To get a window of its own, install the page as an app in Edge (edge://apps), then put its app id here.
- `harvest`: `true` makes `/q sync` read your Harvest entries and show the hours on each card. Needs the Harvest MCP server.
- `repoCopies`: several checkouts of the BC repo (for example `C:\Projects\BC25_Mars`, `BC25_Venus`), each holding one card at a time. `enabled`, the folder name `pattern`, and the `workspace` file the VS Code button opens inside a copy. Off, cards keep `repo: none` and the steps work where the card says.
- `objectIds`: `true` lets board-implementer declare new objects with ID 0 and has the hook `scripts/assign-ids.js` assign real ones through Ninja when it returns. Needs `repoCopies` on.

`ado.json` holds the ADO side: the area your work items are in, the years to list iterations for, the current iteration and the base branch new work starts from (`baseBranch`). Set `area` and `baseBranch` to yours.

## Working an item

1. Open the app, run `/q` in Claude Code in the board folder, or open `INBOX.md`. Take the top item.
2. Read its card. "Waiting on you" holds numbered closed questions, each saying what A and B lead to.
3. Answer in the app, or by number in chat ("1 A, 2 B").
   - In the app, the answers go into Decisions with the option you picked, and the card moves to `decided`. The next `/q cycle` reads them and moves the card on.
   - In chat, Claude appends the answer to Decisions, moves the card to its next state and rebuilds the inbox.
4. Each card change is one commit in this repo. `git log` is the history of the board.
5. The card is closed for you until it comes back.

## The app

`app\restart.cmd` starts the server hidden (output in `app\server.log`); run it again after changing `server.js`. `app\start.cmd` starts it in a console window and opens the app.

- The left side is the inbox, in the same order as `INBOX.md`, plus decided, agent, review and parked cards, repo copies (when on) and warnings. Drag cards in Waiting on you to set your own order.
- The right side is one card. Click A, B or C per question, and write a note when the letters don't fit. Ctrl+Enter records.
- Code links open a preview, and VS Code at the line on Ctrl+click. ADO links open in the browser.
- Recording writes the card, rebuilds `INBOX.md`, commits, and pushes when there is a remote.
- Card buttons: Back to you, In review, Park (with a revisit date), Done, Re-open and Edit change the card directly, with a dated line under Decisions. No Claude involved.
- Pull, Add (a work item number) and Sync run Claude Code headless (`/q pull from-app`, `/q add <id> from-app`, `/q sync from-app`), with ADO reads and edits to `cards/` and `ado.json` only. The app commits what they wrote.
- Cycle, Run next step and Open in Claude open Claude Code in a terminal window, where you answer permission prompts as in any session.
- Screenshots: Ctrl+V on a card pastes one; it is saved with the card under `attachments/<id>/`.
- The bar at the bottom shows your 5-hour and weekly usage. Cycle and Run next step show an estimate before they start, from your own past runs, and the cycle asks before a step that would run the limits out.
- One job at a time. While one runs, decisions and card edits queue and are recorded when it ends.
- It listens on 127.0.0.1 only. `QUEUE_PORT` changes the port, `QUEUE_NO_PUSH=1` turns pushing off.

`FAQ.md` explains the states, chips, buttons and the inbox order. The app shows it under the ? button.

## The agents

The cycle runs three agents from `.claude/agents/`, based on the shared ones in `core-bc-al/.claude/agents`: board-planner, board-implementer and board-reviewer. Each reads the card, then the repo's own `CLAUDE.md` and `.claude/rules/` in the card's repo copy, so the rules stay current. They differ from the shared agents in two ways: every branch, commit, PR or ADO write becomes a question on the card instead of happening, and each report ends with a `For the card` block the cycle writes onto the card. There is no tester step. When the shared agents change, copy what you want into these.

## Rules the cycle keeps

1. Never commits, branches, pushes, opens a PR or writes to ADO in a BC repo without a decision for that exact write on the card.
2. With repo copies on, one copy holds one in-flight card, and the copy's branch must match `branch` on the card before a step.
3. Open loops live on cards, facts live in memory.
4. Every agent brief names the card, and the agent's `For the card` block goes onto it.
5. A card that comes back with the same question twice (`bounces` 2 or more) gets flagged. Rephrase it or park it.

## Files

- `config.json`: your setup (above). `ado.json`: the ADO side and what the last pull and sync did.
- `cards/_template.md`: copy for a new card.
- `.claude/skills/q/SKILL.md`: the `/q` skill. It works in Claude Code sessions started in this folder, which is where the app starts them.
- `.claude/agents/`: the board's agents. `.claude/settings.json`: the object ID hook and git deny rules.
- `scripts/Get-Inbox.ps1`: reads cards, checks repo copies, writes `INBOX.md`. `-Check` validates only, `-Json` gives the app the board.
- `scripts/card-time.js`: Claude's and your time per card from the Claude Code transcripts, and past token use for the estimates.
- `scripts/limit-check.js`: the cycle's usage gate.
- `scripts/assign-ids.js`: the object ID hook (with `objectIds` on).
- `scripts/config.js`: reads `config.json` for the Node scripts.
- `app/`: `server.js` (Node, no packages), `index.html`, `start.cmd`, `restart.cmd`, the manifest and icons, and the themes.
