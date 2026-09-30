# dft demo: many worktrees, one branch each

Run on 2026-09-30 with `cursor-agent` 2026.09.28 and dft 0.1.5 from this checkout. All outputs below are real, copied from the terminal. Paths are shortened: `<demo>` is a throwaway folder, `<replay>` is the folder for part 2. Prompts are left out. `DFT_HOME` pointed at a throwaway folder, so `~/.dft` was not touched.

The Cursor account ran out of usage during this demo. Every `cursor-agent` call, with Auto or a named model, stopped with `You've hit your usage limit`. So the demo has two parts:

1. **Live runs.** Three `cursor-agent` runs in parallel, one per worktree, and one run in the main checkout that asks for edits in the three worktrees. The hooks fired and dft recorded each chat on the right branch. Cursor reported no tokens, because the runs were refused.
2. **Recorded runs.** The same setup, rebuilt from four real `cursor-agent` runs recorded earlier the same day (`packages/core/test/dx/integration/fixtures/parallel-worktrees`, prompts and replies removed). Their hook data and stream files were put where dft reads them, then every command below was run with the normal CLI. This part checks the token split.

## Setup

```sh
export DFT_HOME=<demo>/home
git init -b main <demo>/repo && cd <demo>/repo
# add calc.py and README.md, commit
dft install
for s in a b c; do git worktree add -b feature/sub-$s ../wt-$s; done
dft install                  # lists the worktrees that are not set up
dft install --all-worktrees
```

```text
Other worktrees
  3 other worktrees of this repo have no dft hooks yet: wt-a, wt-b, wt-c
  Set them up too:  dft install --all-worktrees
```

```text
Other worktrees
  ✓ wt-a            Cursor hooks and skills
  ✓ wt-b            Cursor hooks and skills
  ✓ wt-c            Cursor hooks and skills
```

## Part 1: live runs

Three runs at the same time, each started inside its own worktree:

```sh
(cd ../wt-a && cursor-agent -p --force --trust --output-format stream-json "<task a>" > a.jsonl) &
(cd ../wt-b && cursor-agent -p --force --trust --output-format stream-json "<task b>" > b.jsonl) &
(cd ../wt-c && cursor-agent -p --force --trust --output-format stream-json "<task c>" > c.jsonl) &
wait
```

All three stopped after about 3 seconds with the usage-limit error. Three more short runs in `wt-a` (Auto, `composer-2.5`, `gpt-5.3-codex-low`) checked whether any model was allowed; none was. Then one run in the main checkout asked for three subagents to edit files in `wt-a`, `wt-b` and `wt-c`. It was refused too. The code changes in each worktree were made by hand and committed, one commit per branch.

The hook data went to the right place: each worktree's runs have their own spool folder, and every record names its own branch and worktree.

```text
$ dft history
BRANCH         WORKTREE  STATUS  LAST ACTIVE  AGENT TIME  TOKENS  BILLED  ESTIMATE  CHATS  COMMITS
feature/sub-a  wt-a      open    5 min ago           <1m       —       —         —      4        1
feature/sub-b  wt-b      open    5 min ago           <1m       —       —         —      1        1
feature/sub-c  wt-c      open    5 min ago           <1m       —       —         —      1        1
main           repo      open    5 min ago           <1m       —       —         —      1        1

$ dft history --oneline
feature/sub-a (worktree: wt-a)  <1m agent · 4 chats · 1 commit
feature/sub-b (worktree: wt-b)  <1m agent · 1 chat · 1 commit
feature/sub-c (worktree: wt-c)  <1m agent · 1 chat · 1 commit
main                            <1m agent · 1 chat · 1 commit
```

`feature/sub-a` has 4 chats: its task plus the three model checks. The refused run from the main checkout is the one chat on `main`. It made no edits, so nothing moved to the worktree branches.

```text
$ cd ../wt-a && dft chats
4 chats on feature/sub-a

chat 0f2858b0
  — cost · — tokens · — time
  Auto ×1

chat d0b27659
  — cost · — tokens · — time
  Auto ×1

chat c20e8db0
  — cost · — tokens · — time
  composer-2.5 ×1

chat d899a7df
  — cost · — tokens · — time
  gpt-5.3-codex low ×1

$ dft analyze
feature/sub-a · open · 7 min old

Cost    —
Tokens  —
Time    7m on branch · 1m active · <1m agent
Work    1 commit · 1 file · +4 −0 lines
Models  Auto 50% · composer-2.5 25% · gpt-5.3-codex 25%

No AI cost or tokens recorded for this branch yet.
Use Cursor on this branch, then run dft analyze again.
```

`dft dashboard --no-open --json --out <demo>/d-live.html` reported `"branches": 4`. The page names all three feature branches. It has none of the prompt text and loads nothing from the internet.

## Part 2: recorded runs, token split

Four real runs recorded earlier: one agent per worktree (`sub-a`, `sub-b`, `sub-c`) and one parent agent in the main checkout that started two subagents. The subagents edited files in `sub-b` and `sub-c`. The stream files were imported from inside each worktree:

```sh
cd <replay>/sub-a && dft collect --source collector/cursor-cli --input sub-a.stream.jsonl
# same for main, sub-b, sub-c
```

`result.usage` in each stream file, next to what dft shows:

| Run | Stream input | Stream cached | Stream output | dft branch | dft tokens |
| --- | --: | --: | --: | --- | --- |
| main (parent) | 58,213 | 131,072 | 2,931 | main | 192k (58k in · 131k cached · 2.9k out) |
| sub-a | 21,907 | 48,640 | 1,184 | feature/sub-a | 72k (22k in · 49k cached · 1.2k out) |
| sub-b | 12,406 | 30,720 | 488 | feature/sub-b | 44k (12k in · 31k cached · 488 out) |
| sub-c | 34,384 | 66,304 | 710 | feature/sub-c | 101k (34k in · 66k cached · 710 out) |

`dft history --json` has the exact numbers, one request per branch, and nothing counted twice:

```text
{"branch": "feature/sub-c", "worktree": "sub-c", "input": 34384, "cachedInput": 66304, "output": 710, "requests": 1, "chats": 2}
{"branch": "feature/sub-b", "worktree": "sub-b", "input": 12406, "cachedInput": 30720, "output": 488, "requests": 1, "chats": 2}
{"branch": "feature/sub-a", "worktree": "sub-a", "input": 21907, "cachedInput": 48640, "output": 1184, "requests": 1, "chats": 1}
{"branch": "main", "worktree": "main", "input": 58213, "cachedInput": 131072, "output": 2931, "requests": 1, "chats": 1}
```

(Shortened with a small script: token categories, request and chat counts per row.)

```text
$ dft history
BRANCH         WORKTREE  STATUS  LAST ACTIVE  AGENT TIME  TOKENS  BILLED  ESTIMATE  CHATS  COMMITS
feature/sub-c  sub-c     open    2 hours ago         <1m    101k       —         —      2        1
feature/sub-b  sub-b     open    2 hours ago         <1m     44k       —         —      2        1
feature/sub-a  sub-a     open    2 hours ago         <1m     72k       —         —      1        1
main           main      open    2 hours ago         <1m    192k       —         —      1        1

$ dft history --oneline
feature/sub-c (worktree: sub-c)  101k tokens · <1m agent · 2 chats · 1 commit
feature/sub-b (worktree: sub-b)  44k tokens · <1m agent · 2 chats · 1 commit
feature/sub-a (worktree: sub-a)  72k tokens · <1m agent · 1 chat · 1 commit
main                             192k tokens · <1m agent · 1 chat · 1 commit
```

The main checkout's folder is named `main` in this layout, so the WORKTREE column shows `main` for it.

### The parent agent's edits in other worktrees

The subagents' edits in `sub-b` and `sub-c` are counted on those branches, under the parent chat, with an `Also on` line. The parent's tokens stay on `main`, where the chat ran.

```text
$ cd <replay>/main && dft chats
1 chat on main, with 2 subagents

chat ddb00c12
  — cost · 192k tokens · <1m · 7 tool calls
  Auto ×2
  Also on feature/sub-b, feature/sub-c
└─ subagent: chat 392e0511
     — cost · — tokens · — time
     composer-1 ×1
└─ subagent: chat ec67309d
     — cost · — tokens · — time
     composer-1 ×1

$ cd <replay>/sub-b && dft chats
2 chats on feature/sub-b

chat 4e26eeed
  — cost · 44k tokens · <1m · 8 tool calls
  Auto ×2

chat ddb00c12
  — cost · — tokens · — time
  Auto ×1
  Also on main, feature/sub-c
```

```text
$ cd <replay>/sub-c && dft line
feature/sub-c (worktree: sub-c)  101k tokens · <1m agent · 2 chats · 1 commit

$ dft analyze
feature/sub-c · open · 3 hours old

Cost    —
Tokens  34k in · 66k cached · 710 out
Time    3h 16m on branch · 7m active · <1m agent
Work    1 commit · 1 file · +1 −0 lines · 8 tool calls · 1 request
Models  Auto 100%

Missing: billed, Cursor's figure, estimate. Add --verbose to see why.
```

Cost is empty because all runs used Auto, which has no fixed price, and the Cursor usage import is off for a store outside `~/.dft`.

### Dashboard

```text
$ dft dashboard --no-open --json --out <demo>/d.html
{ "branches": 4, "generatedAt": "2026-09-30T14:46:04.873Z", "opened": false, "path": "<demo>/d.html" }
```

The page (13 KB) shows 409k tokens in total, one row per branch with its worktree, and the same `Also on` lines under each branch's chats. It has no prompt text and no links to the internet.

## Fixed during this demo

- `dft chats` counted subagents as chats (`3 chats on main`) while `dft line` said `1 chat`. It now says `1 chat on main, with 2 subagents`.
- `dft chats` did not say when a chat also worked on other branches. It now prints `Also on <branches>`, like the dashboard.
- Auto showed up as both `default` (from hooks) and `Auto` (from the stream), for example `default ×1, Auto ×1` and `Models default 50% · Auto 50%`. Both now read `Auto`. `--json` still has the raw model name.

## Still open

- Refused runs (usage limit) look like normal chats with no tokens. Nothing says they failed.
- With `DFT_HOME` outside `~/.dft`, the Cursor usage import is off, so billed cost stays empty.
- `dft analyze` and `dft chats` can count tool calls a little differently for the same branch (7 vs 8), because they read different sources.
