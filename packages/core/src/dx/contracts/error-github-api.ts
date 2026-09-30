import { Schema } from "effect";

export class GitHubApiError extends Schema.TaggedError<GitHubApiError>()(
  "GitHubApiError",
  {
    kind: Schema.Literals([
      "no-auth",
      "expired-auth",
      "forbidden",
      "rate-limited",
      "not-found",
      "server",
      "network",
      "partial",
    ]),
    message: Schema.String,
    route: Schema.String,
    status: Schema.NullOr(Schema.Int),
  }
) {}
