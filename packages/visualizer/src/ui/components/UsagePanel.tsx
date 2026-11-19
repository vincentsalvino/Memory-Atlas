import { useState } from "react";
import type { UsageRanking } from "@brain/contracts";

export function UsagePanel({ rows }: { rows: UsageRanking[] }) {
  const [kind, setKind] = useState("");
  const [harness, setHarness] = useState("");
  const [stage, setStage] = useState("");
  const hasFilters = Boolean(kind || harness || stage);
  const harnesses = [...new Set(rows.flatMap((r) => (r.harnessId ? [r.harnessId] : [])))].sort();
  const filtered = rows.filter(
    (r) => (!kind || r.kind === kind) && (!harness || r.harnessId === harness) && (!stage || r.stage === stage),
  );

  return (
    <section className="panel usage-panel" aria-label="Skill, plugin and tool usage">
      <header className="dashboard-panel-header">
        <h2>Skills, plugins and tools</h2>
        <div className="filter-group" role="group" aria-label="Filter usage rankings">
          <label className="compact-select-field">
            <span>Kind</span>
            <select className="filter-input compact-select" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All kinds</option>
              {["skill", "plugin", "tool"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="compact-select-field">
            <span>Harness</span>
            <select className="filter-input compact-select" value={harness} onChange={(e) => setHarness(e.target.value)}>
              <option value="">All harnesses</option>
              {harnesses.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="compact-select-field">
            <span>Stage</span>
            <select className="filter-input compact-select" value={stage} onChange={(e) => setStage(e.target.value)}>
              <option value="">All stages</option>
              {["installed", "exposed", "loaded", "invoked"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          {hasFilters && (
            <button
              type="button"
              className="text-button compact-reset"
              onClick={() => {
                setKind("");
                setHarness("");
                setStage("");
              }}
            >
              Reset
            </button>
          )}
        </div>
      </header>
      <div className="panel-body">
        <p className="usage-note">
          Brain calls are observed automatically. Skill/plugin events are explicitly reported. Unreported external
          activity is unknown. Counts do not measure token savings. Up to 200 ranking groups are shown.
        </p>
        {filtered.length === 0 ? (
          <p className="meta">
            {rows.length ? "No usage matches these filters." : "No usage recorded yet. Connect a harness to begin."}
          </p>
        ) : (
          <div className="usage-table">
            <table>
              <thead>
                <tr>
                  <th>Capability / harness</th>
                  <th>Stage / evidence</th>
                  <th>Count</th>
                  <th>Success</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={i}>
                    <td>
                      {r.kind}: {r.identifier}
                      <br />
                      <small>
                        {r.harnessId ?? "Unidentified"}
                        {r.projectId ? ` / ${r.projectId}` : ""}
                      </small>
                    </td>
                    <td>
                      {r.stage} / {r.source}
                    </td>
                    <td>{r.count}</td>
                    <td>{r.successRate === null ? "Unknown" : `${Math.round(r.successRate * 100)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
