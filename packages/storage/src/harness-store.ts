import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { HarnessObservability, RuntimeConfig, UsageEvent, UsageRanking } from "@brain/contracts";

export class SqliteHarnessStore implements HarnessObservability {
  constructor(private readonly db: Database.Database) {}
  async recordUsage(e: UsageEvent): Promise<void> {
    this.db.prepare(`INSERT INTO usage_events VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      randomUUID(), new Date().toISOString(), e.kind, e.identifier, e.stage, e.source,
      e.harnessId, e.projectId, e.success === null ? null : Number(e.success), e.durationMs);
  }
  async rankings(harnessId?: string | null): Promise<UsageRanking[]> {
    return this.db.prepare(`SELECT kind, identifier, stage, source, harness_id AS harnessId,
      project_id AS projectId, COUNT(*) AS count, AVG(success) AS successRate, MAX(timestamp) AS lastSeen
      FROM usage_events ${harnessId === undefined ? "" : harnessId === null ? "WHERE harness_id IS NULL" : "WHERE harness_id = ?"}
      GROUP BY kind, identifier, stage, source, harness_id, project_id ORDER BY count DESC, identifier ASC LIMIT 200`)
      .all(...(harnessId == null ? [] : [harnessId])) as UsageRanking[];
  }
  heartbeat(id: string, harnessId: string | null, config: RuntimeConfig): void {
    this.db.prepare(`INSERT INTO runtime_instances VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      updated_at=excluded.updated_at, learning_enabled=excluded.learning_enabled, redundancy_enabled=excluded.redundancy_enabled`)
      .run(id, harnessId, new Date().toISOString(), Number(config.learningEnabled), Number(config.redundancyEnabled));
  }
  removeInstance(id: string): void { this.db.prepare("DELETE FROM runtime_instances WHERE id = ?").run(id); }
  runtimeStatus(): { learningEnabled: boolean | null; redundancyEnabled: boolean | null; instances: number } {
    const rows = this.db.prepare("SELECT learning_enabled, redundancy_enabled FROM runtime_instances WHERE updated_at >= ?")
      .all(new Date(Date.now() - 90_000).toISOString()) as {learning_enabled: number; redundancy_enabled: number}[];
    const consensus = (key: "learning_enabled" | "redundancy_enabled") => rows.length && rows.every(r => r[key] === rows[0]![key]) ? Boolean(rows[0]![key]) : null;
    return { learningEnabled: consensus("learning_enabled"), redundancyEnabled: consensus("redundancy_enabled"), instances: rows.length };
  }
}
