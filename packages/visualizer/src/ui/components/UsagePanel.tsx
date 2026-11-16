import { useState } from "react";
import type { UsageRanking } from "@brain/contracts";

export function UsagePanel({ rows }: { rows: UsageRanking[] }) {
  const [kind, setKind] = useState("");
  const [harness, setHarness] = useState("");
  const [stage, setStage] = useState("");
  const filtered = rows.filter(r => (!kind || r.kind === kind) && (!harness || r.harnessId === harness) && (!stage || r.stage === stage));
  return <section className="panel" aria-label="Skill, plugin and tool usage">
    <header className="dashboard-panel-header"><h2>Skills, plugins and tools</h2></header>
    <div className="panel-body">
      <p>Brain calls are observed automatically. Skill/plugin events are explicitly reported. Unreported external activity is unknown. Counts do not measure token savings. Up to 200 ranking groups are shown.</p>
      <div className="context-filters">
        <label>Kind <select className="filter-input" value={kind} onChange={e => setKind(e.target.value)}>
          <option value="">All kinds</option>{["skill", "plugin", "tool"].map(v => <option key={v}>{v}</option>)}</select></label>
        <label>Harness <select className="filter-input" value={harness} onChange={e => setHarness(e.target.value)}>
          <option value="">All harnesses</option>{[...new Set(rows.flatMap(r => r.harnessId ? [r.harnessId] : []))].sort().map(v => <option key={v}>{v}</option>)}</select></label>
        <label>Stage <select className="filter-input" value={stage} onChange={e => setStage(e.target.value)}>
          <option value="">All stages</option>{["installed", "exposed", "loaded", "invoked"].map(v => <option key={v}>{v}</option>)}</select></label>
      </div>
      {filtered.length === 0 ? <p>{rows.length ? "No usage matches these filters." : "No usage recorded yet. Connect a harness to begin."}</p> :
        <div className="usage-table"><table><thead><tr><th>Capability / harness</th><th>Stage / evidence</th><th>Count</th><th>Success</th></tr></thead>
          <tbody>{filtered.map((r, i) => <tr key={i}><td>{r.kind}: {r.identifier}<br /><small>{r.harnessId ?? "Unidentified"}{r.projectId ? ` / ${r.projectId}` : ""}</small></td>
            <td>{r.stage} / {r.source}</td><td>{r.count}</td><td>{r.successRate === null ? "Unknown" : `${Math.round(r.successRate * 100)}%`}</td></tr>)}</tbody></table></div>}
    </div>
  </section>;
}
