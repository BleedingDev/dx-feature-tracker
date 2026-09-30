B46 synthetic Entire checkpoint fixtures (origin: fixture). Layout mirrors the entire/checkpoints/v1 branch shape: <id[:2]>/<id[2:]>/metadata.json (checkpoint root, aggregate token_usage) and <n>/metadata.json + <n>/full.jsonl per session. No real Entire data.
- delta-windows (fixture id b46-entire-delta-windows): sess-1 spans two checkpoints with strictly increasing checkpoint_transcript_start; sess-2 single.
- cumulative-unverified (fixture id b46-entire-cumulative-unverified): sess-9 spans two checkpoints without offsets, plus one malformed metadata file.
