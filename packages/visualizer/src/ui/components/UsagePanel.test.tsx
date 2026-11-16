import { test, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UsagePanel } from "./UsagePanel";

test("separates reported skills from observed tools and filters to skills", () => {
  render(<UsagePanel rows={[
    {kind: "skill", identifier: "review", stage: "loaded", source: "reported", harnessId: "a", projectId: "example", count: 4, successRate: null, lastSeen: "now"},
    {kind: "tool", identifier: "brain_context", stage: "invoked", source: "observed", harnessId: "a", projectId: null, count: 8, successRate: 1, lastSeen: "now"},
  ]} />);
  expect(screen.getByText("skill: review")).toBeTruthy();
  expect(screen.getByText("Unknown")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Kind"), {target: {value: "skill"}});
  expect(screen.queryByText("tool: brain_context")).toBeNull();
  fireEvent.change(screen.getByLabelText("Stage"), {target: {value: "installed"}});
  expect(screen.getByText("No usage matches these filters.")).toBeTruthy();
});
