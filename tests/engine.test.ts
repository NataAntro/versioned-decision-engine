import assert from "node:assert/strict";
import { test } from "node:test";
import { RuleBook, StalePreviewError, evaluate } from "../src/engine.ts";
import type { Rule } from "../src/engine.ts";

const queue: Rule = {
  id: "queue",
  title: "Queue",
  prerequisites: [{ fact: "jobsPerHour", operator: "atLeast", value: 10 }],
  signals: [
    {
      condition: { fact: "jobsPerHour", operator: "atLeast", value: 50 },
      points: 9,
    },
  ],
};
const evidence = { jobsPerHour: { value: 70, source: "Generated fixture" } };
const simple = (id: string): Rule => ({
  id,
  title: id,
  prerequisites: [],
  signals: [],
});

test("shows evidence, distinguishes missing from failed, ranks only eligible rules", () => {
  const missing: Rule = {
    ...queue,
    id: "missing",
    prerequisites: [{ fact: "responders", operator: "atLeast", value: 2 }],
  };
  const failed: Rule = {
    ...queue,
    id: "failed",
    prerequisites: [{ fact: "jobsPerHour", operator: "atMost", value: 10 }],
  };
  const result = evaluate(
    new RuleBook([queue, missing, failed]).active,
    evidence,
  );
  assert.deepEqual(result.ranking, ["queue"]);
  const [no, unknown, yes] = result.decisions;
  assert.equal(no!.status, "ineligible");
  assert.equal(no!.signals[0]!.outcome, "met");
  assert.equal(no!.signals[0]!.pointsAwarded, 0);
  assert.equal(unknown!.status, "needs-evidence");
  assert.equal(unknown!.prerequisites[0]!.evidence, null);
  assert.equal(yes!.signals[0]!.pointsAwarded, 9);
  assert.deepEqual(yes!.prerequisites[0]!.evidence, evidence.jobsPerHour);
});

test("previews additions, modifications and removals before changing the active version", () => {
  const book = new RuleBook([simple("obsolete"), queue]);
  const draft = book.preview([
    { ...queue, title: "Queue review" },
    simple("new"),
  ]);
  assert.equal(book.active.id, 1);
  assert.deepEqual(draft.changes, {
    added: ["new"],
    updated: ["queue"],
    removed: ["obsolete"],
  });
  const next = book.publish(draft);
  assert.equal(next.parent, 1);
  assert.equal(next.digest, draft.digest);
  assert.deepEqual(
    next.rules.map((rule) => rule.id),
    ["new", "queue"],
  );
});

test("historical runs replay with the same evidence and version after a ruleset change", () => {
  const book = new RuleBook([queue]);
  const input = { jobsPerHour: { value: 70, source: "Generated fixture" } };
  const original = evaluate(book.active, input);
  book.publish(book.preview([{ ...queue, signals: [] }]));
  assert.notDeepEqual(evaluate(book.active, input), original);
  input.jobsPerHour.value = 1;
  assert.deepEqual(
    evaluate(book.get(original.version), original.facts),
    original,
  );
  const restored = book.publish(book.preview(book.get(1).rules));
  assert.equal(restored.id, 3);
  assert.equal(restored.digest, original.digest);
});

test("rejects stale and foreign reviews and keeps the current active version", () => {
  const book = new RuleBook([queue]);
  const stale = book.preview([]);
  const foreign = new RuleBook([]).preview([]);
  book.publish(book.preview([simple("other")]));
  assert.throws(() => book.publish(stale), StalePreviewError);
  assert.throws(() => book.publish(foreign), TypeError);
  assert.equal(book.active.id, 2);
});

test("rejects duplicate IDs and invalid evidence, freezes validated inputs", () => {
  const book = new RuleBook([queue]);
  assert.throws(() => book.preview([queue, queue]), TypeError);
  assert.throws(
    () =>
      evaluate(book.active, { jobsPerHour: { value: -1, source: "example" } }),
    TypeError,
  );
  const rule = { ...queue, title: "Candidate" };
  const preview = book.preview([rule]);
  rule.title = "Changed outside review";
  assert.ok(Object.isFrozen(preview.rules[0]!.signals[0]!.condition));
  assert.equal(book.publish(preview).rules[0]!.title, "Candidate");
});

test("canonical rule order gives stable hashes and tie breaks", () => {
  const first = new RuleBook([simple("bravo"), simple("alpha")]).active;
  const second = new RuleBook([simple("alpha"), simple("bravo")]).active;
  assert.equal(first.digest, second.digest);
  assert.deepEqual(evaluate(first, {}).ranking, ["alpha", "bravo"]);
});
