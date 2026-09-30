---
name: dx-dashboard
description: Open a simple local web page showing the AI cost of every branch (billed, estimate, tokens, agent time, chats per branch). Use when the user wants to see costs visually, asks for a dashboard, a page, a chart or an overview they can click through, or wants something to show to a teammate.
---

# dx-dashboard

Opens the local cost page with the `dft` CLI.

## Run

```sh
dft dashboard [--all-repos] [--since 30d]
```

- It writes one local HTML file (default `~/.dft/dashboard.html`) and opens it in the browser. The page loads nothing from the internet.
- Add `--all-repos` when the user wants every project, `--since` for a time window (`7d`, `30d`, a date).
- To save without opening (for example to attach or share the file): `dft dashboard --no-open --out <path>`. Add `--json` to get the saved path back.
- Newer versions keep the page open and refresh it live; if `dft dashboard --help` lists `--one-time`, use `dft dashboard --one-time` when the user only wants the file.

## After running

Tell the user in one or two lines where the file is and what they can do there: click a branch to see its chats and models. Do not paste the HTML into the chat.

## Rules

- Never upload or send the file anywhere unless the user asks.
- If `dft` is not installed, give the install command: `npm i -g https://github.com/BleedingDev/dx-feature-tracker/releases/latest/download/dx-feature-tracker.tgz`.
- For numbers in the chat instead of a page, use `dx-history` or `dx-analyze`.
