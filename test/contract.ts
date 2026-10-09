import { expect } from "vitest";

/**
 * Asserts `actual` has exactly the shape of `example`: the same keys, with
 * the same JSON types, recursively. Values are not compared - an example's
 * values are illustrative - but a missing, extra or retyped field fails.
 */
export function expectShape(actual: unknown, example: unknown, path = "$"): void {
  expect(kind(actual), `${path} has the example's type`).toBe(kind(example));
  if (Array.isArray(example) && Array.isArray(actual) && example.length > 0) {
    for (const [i, item] of actual.entries()) expectShape(item, example[0], `${path}[${i}]`);
  } else if (kind(example) === "object") {
    const a = actual as Record<string, unknown>;
    const e = example as Record<string, unknown>;
    expect(Object.keys(a).sort(), `${path} has the example's keys`).toEqual(Object.keys(e).sort());
    for (const key of Object.keys(e)) expectShape(a[key], e[key], `${path}.${key}`);
  }
}

function kind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
