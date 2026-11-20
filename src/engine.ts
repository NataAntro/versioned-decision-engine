import { createHash } from "node:crypto";

const factNames = ["jobsPerHour", "recoveryMinutes", "responders"] as const;
type Fact = (typeof factNames)[number];
export type Evidence = Readonly<{ value: number; source: string }>;
export type Facts = Readonly<Partial<Record<Fact, Evidence>>>;
export type Condition = Readonly<{
  fact: Fact;
  operator: "atLeast" | "atMost";
  value: number;
}>;
export type Signal = Readonly<{ condition: Condition; points: number }>;
export type Rule = Readonly<{
  id: string;
  title: string;
  prerequisites: readonly Condition[];
  signals: readonly Signal[];
}>;
export type Version = Readonly<{
  id: number;
  parent: number | null;
  digest: string;
  rules: readonly Rule[];
}>;
export type Preview = Readonly<{
  base: number;
  digest: string;
  rules: readonly Rule[];
  changes: Readonly<{
    added: readonly string[];
    updated: readonly string[];
    removed: readonly string[];
  }>;
}>;

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function integer(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function normalizeCondition({ fact, operator, value }: Condition): Condition {
  if (
    !factNames.includes(fact) ||
    !["atLeast", "atMost"].includes(operator) ||
    !integer(value, 0, 1_000_000)
  ) {
    throw new TypeError("Invalid rule condition");
  }
  return Object.freeze({ fact, operator, value });
}

function normalizeRules(input: readonly Rule[]): readonly Rule[] {
  const identifiers = new Set<string>();
  return Object.freeze(
    input
      .map(({ id, title, prerequisites, signals }) => {
        if (
          !/^[a-z][a-z0-9-]{0,39}$/.test(id) ||
          typeof title !== "string" ||
          !title.trim() ||
          identifiers.has(id)
        ) {
          throw new TypeError("Invalid or duplicate rule ID or empty title");
        }
        identifiers.add(id);
        return Object.freeze({
          id,
          title,
          prerequisites: Object.freeze(prerequisites.map(normalizeCondition)),
          signals: Object.freeze(
            signals.map(({ condition, points }) => {
              if (!integer(points, 1, 100))
                throw new RangeError("Invalid signal points");
              return Object.freeze({
                condition: normalizeCondition(condition),
                points,
              });
            }),
          ),
        });
      })
      .sort((a, b) => compareId(a.id, b.id)),
  );
}

function digest(rules: readonly Rule[]): string {
  return createHash("sha256").update(JSON.stringify(rules)).digest("hex");
}

export class StalePreviewError extends Error {}

export class RuleBook {
  readonly #versions: Version[] = [];
  readonly #previews = new WeakSet<Preview>();

  constructor(initial: readonly Rule[]) {
    const rules = normalizeRules(initial);
    this.#append(rules, digest(rules), null);
  }

  get active(): Version {
    return this.#versions.at(-1)!;
  }

  get(id: number): Version {
    if (!integer(id, 1, this.#versions.length))
      throw new RangeError("Unknown ruleset version");
    return this.#versions[id - 1]!;
  }

  preview(candidate: readonly Rule[]): Preview {
    const current = this.active;
    const rules = normalizeRules(candidate);
    const before = new Map(current.rules.map((rule) => [rule.id, rule]));
    const after = new Set(rules.map((rule) => rule.id));
    const added: string[] = [];
    const updated: string[] = [];
    for (const rule of rules) {
      const previous = before.get(rule.id);
      if (!previous) added.push(rule.id);
      else if (JSON.stringify(previous) !== JSON.stringify(rule))
        updated.push(rule.id);
    }
    const removed = current.rules
      .filter((rule) => !after.has(rule.id))
      .map((rule) => rule.id);
    const preview = Object.freeze({
      base: current.id,
      digest: digest(rules),
      rules,
      changes: Object.freeze({
        added: Object.freeze(added),
        updated: Object.freeze(updated),
        removed: Object.freeze(removed),
      }),
    });
    this.#previews.add(preview);
    return preview;
  }

  publish(preview: Preview): Version {
    if (!this.#previews.has(preview))
      throw new TypeError("Publish requires a preview from this rulebook");
    if (preview.base !== this.active.id)
      throw new StalePreviewError("Preview is based on an older version");
    return this.#append(preview.rules, preview.digest, preview.base);
  }

  #append(
    rules: readonly Rule[],
    hash: string,
    parent: number | null,
  ): Version {
    const version = Object.freeze({
      id: this.#versions.length + 1,
      parent,
      digest: hash,
      rules,
    });
    this.#versions.push(version);
    return version;
  }
}

function snapshot(input: Facts): Facts {
  const facts: Partial<Record<Fact, Evidence>> = {};
  for (const key of factNames) {
    const evidence = input[key];
    if (!evidence) continue;
    if (
      !integer(evidence.value, 0, 1_000_000) ||
      typeof evidence.source !== "string" ||
      !evidence.source.trim()
    ) {
      throw new TypeError("Facts require a bounded integer and a source");
    }
    facts[key] = Object.freeze({
      value: evidence.value,
      source: evidence.source,
    });
  }
  return Object.freeze(facts);
}

function compare(condition: Condition, facts: Facts) {
  const evidence = facts[condition.fact] ?? null;
  let outcome: "met" | "failed" | "missing" = "missing";
  if (evidence) {
    const matches =
      condition.operator === "atLeast"
        ? evidence.value >= condition.value
        : evidence.value <= condition.value;
    outcome = matches ? "met" : "failed";
  }
  return Object.freeze({ condition, evidence, outcome });
}

function explain(rule: Rule, facts: Facts) {
  const prerequisites = Object.freeze(
    rule.prerequisites.map((condition) => compare(condition, facts)),
  );
  let status: "eligible" | "ineligible" | "needs-evidence" = "eligible";
  if (prerequisites.some((check) => check.outcome === "failed"))
    status = "ineligible";
  else if (prerequisites.some((check) => check.outcome === "missing"))
    status = "needs-evidence";
  const signals = Object.freeze(
    rule.signals.map(({ condition, points }) => {
      const evaluation = compare(condition, facts);
      const pointsAwarded =
        status === "eligible" && evaluation.outcome === "met" ? points : 0;
      return Object.freeze({ ...evaluation, pointsAwarded });
    }),
  );
  const score =
    status === "eligible"
      ? signals.reduce((sum, signal) => sum + signal.pointsAwarded, 0)
      : null;
  return Object.freeze({
    id: rule.id,
    title: rule.title,
    status,
    score,
    prerequisites,
    signals,
  });
}

export function evaluate(version: Version, evidence: Facts) {
  const facts = snapshot(evidence);
  const decisions = Object.freeze(
    version.rules.map((rule) => explain(rule, facts)),
  );
  const ranked = decisions
    .filter((decision) => decision.score !== null)
    .sort((a, b) => b.score! - a.score! || compareId(a.id, b.id));
  return Object.freeze({
    version: version.id,
    digest: version.digest,
    facts,
    decisions,
    ranking: Object.freeze(ranked.map((decision) => decision.id)),
  });
}
