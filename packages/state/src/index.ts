export type JobState =
  | "received"
  | "normalized"
  | "eligible"
  | "leased"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "reclaimed";

