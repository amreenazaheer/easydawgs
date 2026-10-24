/**
 * Unit tests for the evaluator scaffolding: the base-value map, the canonical
 * dimension-key order, and the named error model (Task 1.1).
 */

import { describe, it, expect } from "vitest";
import {
  BASE_VALUES,
  DIMENSION_KEYS,
  EssayRequiredError,
  EvaluationFailedError,
  EvaluationTimeoutError,
  InvalidResponseError,
} from "./evaluator";

describe("BASE_VALUES", () => {
  it("equals the specified per-dimension mapping (Req 3.1-3.6)", () => {
    expect(BASE_VALUES).toEqual({
      focus: 25,
      specificity: 25,
      character: 20,
      how_you_think: 20,
      contribution: 15,
      self_awareness: 10,
    });
  });

  it("sums to 115, the Total_Score maximum (Req 14.1)", () => {
    const total = Object.values(BASE_VALUES).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(115);
  });
});

describe("DIMENSION_KEYS", () => {
  it("contains exactly the six keys in canonical order (Req 1.5)", () => {
    expect(DIMENSION_KEYS).toEqual([
      "focus",
      "specificity",
      "character",
      "how_you_think",
      "contribution",
      "self_awareness",
    ]);
  });

  it("has exactly six keys", () => {
    expect(DIMENSION_KEYS).toHaveLength(6);
  });
});

describe("named error classes", () => {
  const cases = [
    { Ctor: EssayRequiredError, name: "EssayRequiredError" },
    { Ctor: EvaluationFailedError, name: "EvaluationFailedError" },
    { Ctor: EvaluationTimeoutError, name: "EvaluationTimeoutError" },
    { Ctor: InvalidResponseError, name: "InvalidResponseError" },
  ] as const;

  for (const { Ctor, name } of cases) {
    describe(name, () => {
      const error = new Ctor();

      it("extends Error", () => {
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(Ctor);
      });

      it(`sets name to "${name}"`, () => {
        expect(error.name).toBe(name);
      });

      it("carries a non-empty default message", () => {
        expect(typeof error.message).toBe("string");
        expect(error.message.length).toBeGreaterThan(0);
      });
    });
  }
});
