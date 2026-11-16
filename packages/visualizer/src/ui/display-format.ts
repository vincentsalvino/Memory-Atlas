import type { ScopeRef } from "@brain/contracts";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : dateTime.format(date);
}

export function scopeKey(scope: ScopeRef): string {
  return JSON.stringify([scope.kind, scope.id]);
}

export function scopeLabel(scope: ScopeRef): string {
  if (scope.kind === "project" && scope.id?.startsWith("harness:")) {
    const parts = scope.id.split(":");
    try { if (parts.length === 3) return `Private: ${decodeURIComponent(parts[1]!)}  /  ${decodeURIComponent(parts[2]!)}`; } catch { /* Show legacy malformed ids verbatim. */ }
  }
  return scope.id ? `${scope.kind}: ${scope.id}` : scope.kind;
}
