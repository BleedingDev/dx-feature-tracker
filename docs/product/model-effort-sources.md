# Where model and reasoning level come from

Checked read-only on this machine on 2026-09-30 (Cursor 3.22.12, cursor-agent 2026.09.28).

| Source | Model | Granularity | Effort / thinking / max | Confidence |
| --- | --- | --- | --- | --- |
| Hooks (B05) | `model` on every payload, keyed by `conversation_id` + `generation_id`; `subagentStart`/`subagentStop` add `subagent_model`, `subagent_type`, `subagent_id`, `parent_conversation_id` | per turn | only inside the model slug | payload builder in cursor-agent bundle; live run showed `default` (Auto) |
| Local DB `composerData:*` (B06) | `modelConfig.modelName`, `modelConfig.selectedModels[].modelId` | per chat, latest value only | structured: `selectedModels[].parameters` (`effort`, `fast`) and `modelConfig.maxMode` | verified on host |
| Local DB `bubbleId:*` (B06) | `modelInfo.modelName` next to `requestId` | per request (catches mid-chat switches) | slug only | app bundle; no bubbles on host |
| `composerHeaders` (B06) | no | per chat | no; has `isSubagent`, `subagentTypeName` | verified on host |
| `ai-code-tracking.db` (B06) | `model` column | per edit/request | no | verified; values are `default` |
| Agent transcripts (B07) | not present on host | would be per turn | no | host files lack a model field |
| Usage CSV (B08) | `Model` column | per request | `Max Mode` column | docs and fixtures |
| cursor-agent stream-json (B10) | `model` on `system/init` only | per session | slug only | verified; live run showed `Auto` |
| Dashboard JSON (B43) | `model` per event | per request | `maxMode` bool | fixture only |

Slug grammar from `cursor-agent --list-models`: effort suffixes `-low/-medium/-high/-xhigh/-max`, `-thinking-*`, `-fast`; `--model` also accepts `name[effort=…,fast=…]`.

## How dft records it

1. Per turn, keep the raw `model` string keyed by hook `generation_id` or bubble `requestId`. Parse the slug into `effort`, `thinking`, `fast`, marked as derived; leave them null for `auto`/`default`.
2. Structured values override the slug: `selectedModels[].parameters` and `maxMode` from `composerData` (snapshot them into the turn at hook time, since the DB keeps only the latest), and `Max Mode` from the CSV or dashboard.
3. Parse `subagent_model`, `subagent_type` and `parent_conversation_id` from `subagentStart` hooks to get per-subagent models. Treat the stream-json model as a session default only.

When Cursor runs in Auto mode, the actual model is not recorded locally; only the usage CSV or dashboard names it.
