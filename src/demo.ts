import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { RuleBook, StalePreviewError, evaluate } from "./engine.ts";
import type { Facts, Rule } from "./engine.ts";

// Fictional service tiers for a fictional software team's operations workshop.
const initial: readonly Rule[] = [
  {
    id: "queue-review",
    title: "Queue reliability review",
    prerequisites: [{ fact: "jobsPerHour", operator: "atLeast", value: 100 }],
    signals: [
      {
        condition: { fact: "jobsPerHour", operator: "atLeast", value: 400 },
        points: 6,
      },
    ],
  },
  {
    id: "recovery-drill",
    title: "Recovery drill",
    prerequisites: [
      { fact: "recoveryMinutes", operator: "atMost", value: 120 },
    ],
    signals: [
      {
        condition: { fact: "recoveryMinutes", operator: "atMost", value: 60 },
        points: 4,
      },
    ],
  },
  {
    id: "on-call-workshop",
    title: "On-call workshop",
    prerequisites: [{ fact: "responders", operator: "atLeast", value: 2 }],
    signals: [],
  },
];
const facts: Facts = {
  jobsPerHour: { value: 550, source: "Simulated queue snapshot" },
  recoveryMinutes: { value: 45, source: "Example workshop questionnaire" },
};
const rules = new RuleBook(initial);
const before = evaluate(rules.active, facts);
const stale = rules.preview(initial.slice(0, 2));
const review = rules.preview(
  initial.map((rule) =>
    rule.id === "recovery-drill"
      ? {
          ...rule,
          signals: [
            {
              condition: {
                fact: "recoveryMinutes",
                operator: "atMost",
                value: 60,
              },
              points: 8,
            },
          ],
        }
      : rule,
  ),
);
const published = rules.publish(review);
const after = evaluate(published, facts);
const replay = evaluate(rules.get(before.version), before.facts);
assert.deepEqual(replay, before);
assert.throws(() => rules.publish(stale), StalePreviewError);

await mkdir("out", { recursive: true });
await writeFile(
  "out/decisions.json",
  JSON.stringify({ review, before, after, replay }, null, 2) + "\n",
);
console.table([
  {
    scenario: "Original decision",
    version: before.version,
    top: before.ranking[0],
  },
  {
    scenario: "After rule publication",
    version: after.version,
    top: after.ranking[0],
  },
  {
    scenario: "Historical replay",
    version: replay.version,
    top: replay.ranking[0],
  },
]);
console.log(
  "The stale preview was rejected. Inspect out/decisions.json for eligibility, scores and evidence.",
);
