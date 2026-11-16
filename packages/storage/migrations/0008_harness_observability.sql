ALTER TABLE retrieval_events ADD COLUMN harness_id TEXT NULL;
ALTER TABLE context_events ADD COLUMN harness_id TEXT NULL;
ALTER TABLE feedback_events ADD COLUMN harness_id TEXT NULL;
ALTER TABLE outcome_events ADD COLUMN harness_id TEXT NULL;

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY, timestamp TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('tool','skill','plugin')),
  identifier TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('installed','exposed','loaded','invoked')),
  source TEXT NOT NULL CHECK(source IN ('observed','reported')),
  harness_id TEXT NULL, project_id TEXT NULL,
  success INTEGER NULL CHECK(success IN (0,1)), duration_ms REAL NULL CHECK(duration_ms >= 0)
);
CREATE INDEX usage_events_harness_time ON usage_events(harness_id, timestamp);
CREATE TABLE runtime_instances (
  id TEXT PRIMARY KEY, harness_id TEXT NULL, updated_at TEXT NOT NULL,
  learning_enabled INTEGER NOT NULL, redundancy_enabled INTEGER NOT NULL
);
