# Original pitch

The hackathon idea as first written by the team (Czech). An English summary is in the [README](README.md).

Mám nápad na hackathon: DX Flight Recorder 🚀

Cursor nám dnes pomáhá psát kód. My bychom postavili nástroj, který nám ukáže, co se během vývoje skutečně děje a kde developer ztrácí čas.

🎯 Idea

Bereme development jedné feature/branche jako „let“ a sbíráme jeho telemetry:

- Git / commits / changed files
- Cursor / AI usage & tokens
- CI/CD – buildy, testy, failures, waiting time
- GitHub – PR, review cycles, merge
- případně další DX events

Všechno korelujeme přes repository + Git branch.

💥 Demo

Developer je na branchi:

"feature/payment-refactoring"

V Cursoru napíše:

"/dx analyze"

A dostane:

«DX Flight Report

Feature took 3h 42m
AI usage: 4.2M tokens / $7.84
31% of AI-generated code was rewritten

🔴 Biggest friction: CI feedback loop
41 minutes were spent waiting for CI.

🟢 AI retention: 72%

Recommendation:
Improve local integration-test feedback.
Estimated saving: ~20 min per feature.»

A druhý command:

"/dx explain"

zobrazí celý vývoj jako timeline:

"Branch → AI generation → tests → CI failure → AI fix → CI failure → human rework → PR → review → merge"

A systém na konci řekne:

«Where did you lose time?»

🔥 Proč je to zajímavé

Nechceme dělat další AI coding assistant.

Chceme udělat něco jako Flight Recorder pro software development.

Stejně jako observability ukazuje, co se děje v produkci, DX Flight Recorder ukazuje, co se děje během developmentu.

A navíc můžeme začít měřit něco, co dnes často jen odhadujeme:

AI productivity ≠ number of tokens.

Můžeme vidět například:

- kolik AI práce skutečně přežilo review
- kolik bylo přepracováno
- kolik času developer čekal na CI
- kde vzniká friction
- kolik AI stojí konkrétní feature
- jak se mění development flow při používání AI

🛠️ MVP

Na hackathon bychom to držel jednoduché:

Cursor → MCP → Node/TypeScript → SQLite → GitHub API + GitHub Actions

Nejdřív jen:

1. branch detection
2. Git metrics
3. CI metrics
4. AI usage
5. "/dx analyze"
6. "/dx explain"

Dashboard bychom dělali až pokud zbude čas.

Hlavní demo musí fungovat přímo v Cursoru.

---

One-liner pro pitch:
«Cursor helps developers write code. DX Flight Recorder tells them how their development actually went.»
