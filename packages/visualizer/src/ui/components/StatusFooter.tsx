import { Icon } from "./Icon";

interface StatusFooterProps {
  learningEnabled: boolean | null;
  redundancyEnabled: boolean | null;
}

function Dot({ on }: { on: boolean | null }) {
  return <span className={`status-dot ${on === null ? "off" : on ? "on" : "off"}`} />;
}

export function StatusFooter({ learningEnabled, redundancyEnabled }: StatusFooterProps) {
  return (
    <footer className="footer">
      <span className="icon-label">
        <Icon name="database" /> SQLite (readonly)
      </span>
      <span>
        <Dot on={learningEnabled} /> Learning {learningEnabled === null ? "unknown / mixed" : learningEnabled ? "ON" : "OFF"}
      </span>
      <span>
        <Dot on={redundancyEnabled} /> Redundancy {redundancyEnabled === null ? "unknown / mixed" : redundancyEnabled ? "ON" : "OFF"}
      </span>
      <span style={{ marginLeft: "auto" }}>
        <Dot on={true} /> local-only, no network
      </span>
    </footer>
  );
}
