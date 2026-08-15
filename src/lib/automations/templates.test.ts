import { describe, it, expect } from "vitest";
import { getTemplate } from "./templates";

describe("follow_up_reminder — 24h-window fix", () => {
  it("re-engages with a send_template step, not a plain send_message", () => {
    // A plain free-text send_message fired exactly at the 24h mark
    // would be rejected by Meta's Cloud API — free text is only
    // allowed *inside* the customer-service session window. Templates
    // are the correct mechanism outside it.
    const template = getTemplate("follow_up_reminder");
    expect(template).not.toBeNull();
    expect(template!.steps.map((s) => s.step_type)).toEqual([
      "wait",
      "send_template",
    ]);
  });

  it("leaves template_name blank so activation validation forces the user to pick one", () => {
    const template = getTemplate("follow_up_reminder");
    const sendStep = template!.steps.find((s) => s.step_type === "send_template");
    expect(sendStep?.step_config).toMatchObject({ template_name: "" });
  });
});
