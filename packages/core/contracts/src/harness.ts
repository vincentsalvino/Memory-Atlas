import type { ScopeRef } from "./scope.js";

export function privateProjectScope(harnessId: string, projectId: string): ScopeRef {
  return { kind: "project", id: `harness:${encodeURIComponent(harnessId)}:${encodeURIComponent(projectId)}` };
}

export function privateScopeOwner(scope: ScopeRef): string | null {
  if (scope.kind !== "project" || !scope.id?.startsWith("harness:")) return null;
  const parts = scope.id.split(":");
  if (parts.length !== 3 || !parts[1] || !parts[2]) throw new Error("Malformed harness-private project scope");
  return decodeURIComponent(parts[1]);
}

export interface RuntimeConfig { learningEnabled: boolean; redundancyEnabled: boolean }
export function resolveRuntimeConfig(env: Record<string, string | undefined>): RuntimeConfig {
  function flag(name: string): boolean {
    const value = env[name];
    if (value === undefined) return true;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    throw new Error(`${name} must be true, false, 1, or 0`);
  }
  return { learningEnabled: flag("BRAIN_LEARNING_ENABLED"), redundancyEnabled: flag("BRAIN_REDUNDANCY_ENABLED") };
}

export interface UsageEvent {
  kind: "tool" | "skill" | "plugin";
  identifier: string;
  stage: "installed" | "exposed" | "loaded" | "invoked";
  source: "observed" | "reported";
  harnessId: string | null;
  projectId: string | null;
  success: boolean | null;
  durationMs: number | null;
}
export interface UsageRanking extends Omit<UsageEvent, "success" | "durationMs"> {
  count: number; successRate: number | null; lastSeen: string;
}
export interface HarnessObservability {
  recordUsage(event: UsageEvent): Promise<void>;
  rankings(harnessId?: string | null): Promise<UsageRanking[]>;
}
