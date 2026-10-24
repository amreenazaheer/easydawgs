/**
 * LLM-backed application-essay evaluator for the EasyDawg admissions reviewer.
 *
 * This module is the third stage of the EasyDawg pipeline. It reads a student's
 * application essay and produces a structured, deterministic evaluation: an
 * overall `band` (1-5), a mechanics pass/fail with enumerated errors, a
 * six-dimension score breakdown (each anchored to a verbatim quote from the
 * essay), exactly three sentence-level revisions, and a list of opaque UW
 * resource-hub claim identifiers.
 *
 * Browser-native ES module. 1:1 port of evaluator.ts with TypeScript types
 * stripped. Two judgments are made deterministically rather than trusted to the
 * model: the overall `band` is computed by the evaluator (never returned by the
 * LLM), and the verbatim-span and exactly-three-revisions rules are enforced as
 * deterministic validations that reject and retry the LLM response.
 *
 * This file currently establishes the module's public constants and the named
 * error model (task 3.1). The LLM seam, parse/validate stages, deterministic
 * scoring chain, and the async `evaluateEssay` entry point are appended by
 * later tasks (3.2 and 3.3).
 */

/** Maximum time to wait for an LLM evaluation response (Req 11.1). */
export const LLM_TIMEOUT_MS = 30_000;

/**
 * Fixed instruction set supplied to the LLM for every evaluation call (Req 10.4).
 * It encodes every scoring rule the model must apply: the six rubric dimensions
 * and their base values (Req 3); both the linear and motif Focus anchor sets and
 * the rule that selects between them by the `SHAPE` marker in the user message
 * (Req 5.1-5.3); the mechanics pass/fail consistency rule (Req 8); the
 * exactly-three sentence-level revision rule with verbatim `original`s (Req 7.1,
 * 7.3); the verbatim-span rule for each dimension (Req 6.1); the
 * claims-as-opaque-strings rule (Req 9.1); and the exact JSON output schema,
 * which deliberately EXCLUDES `band` because the evaluator computes the band
 * deterministically (Req 13.5).
 *
 * The deterministic `validateLlmEvaluation` and `validateSpansAndRevisions`
 * stages remain the authoritative guards; this prompt only reduces the chance of
 * malformed output. It names no scores and selects no band — those judgments are
 * made in code, never by the model.
 */
export const SYSTEM_PROMPT = `You are an expert reader of college admissions application essays for the EasyDawg admissions reviewer. Your task is to evaluate a single student essay against a fixed rubric and report a structured assessment. Analyze only the essay text provided by the user. Apply the rules below exactly and deterministically.

The user message contains a line beginning with "SHAPE:" followed by either "linear" or "motif", and then the essay body. Use the SHAPE value to select the Focus anchors (see FOCUS ANCHORS below). Treat everything after the essay delimiter as the verbatim essay text; all spans and revision originals you output MUST be exact substrings of that essay text.

DIMENSIONS AND BASE VALUES

Score each of the following six dimensions against its fixed base value (the maximum points before any external adjustment). Do NOT apply any profile weighting yourself — report the raw rubric score for each dimension against its base value:

1. focus — base value 25.
2. specificity — base value 25.
3. character — base value 20.
4. how_you_think — base value 20.
5. contribution — base value 15.
6. self_awareness — base value 10.

Each dimension "score" MUST be a finite number greater than or equal to 0 and no greater than that dimension's base value.

FOCUS ANCHORS (shape-dependent)

Evaluate the focus dimension using the anchor set that corresponds to the SHAPE marker in the user message.

WHEN SHAPE is "linear", evaluate focus using the LINEAR FOCUS ANCHORS:
- The essay advances a single, coherent through-line from beginning to end.
- Episodes or chronological beats build on one another toward one clear point rather than drifting between unrelated topics.
- Each paragraph earns its place by moving that through-line forward; digressions that do not serve the central arc lower the score.
- The strongest focus keeps one controlling idea in view across the whole timeline without losing momentum.

WHEN SHAPE is "motif", evaluate focus using the MOTIF FOCUS ANCHORS:
- A single recurring object, metaphor, or image anchors the narrative and returns two or more times.
- Each recurrence deepens or reframes the motif's meaning rather than merely repeating it.
- The motif ties the essay's separate moments together into one unified reflection.
- The strongest focus makes the motif carry the essay's central idea, so every return to it advances a single coherent point.

MECHANICS CHECK

Assess the essay's grammar, spelling, and punctuation and report it as two fields:
- "mechanics_pass": a JSON boolean (true or false), never a number and never a string.
- "mechanics_errors": a JSON array of strings.
- WHEN "mechanics_pass" is true, "mechanics_errors" MUST be an empty array.
- WHEN "mechanics_pass" is false, "mechanics_errors" MUST contain at least one string, each describing a specific mechanics error.

VERBATIM SPAN RULE

For each of the six dimensions, provide a "span" that justifies the score. Each "span" MUST be a non-empty string that is an EXACT, case-sensitive, character-for-character substring of the essay text, preserving the original whitespace and punctuation. Do NOT paraphrase, trim, normalize, correct, or re-quote the essay — copy the characters exactly. Also provide a non-empty "reasoning" string for each dimension explaining the score.

REVISIONS RULE

Provide EXACTLY THREE revisions in the "revisions" array — no more and no fewer. Each revision is a sentence-level rewrite of a sentence that ALREADY EXISTS in the essay:
- "original" MUST be an EXACT, case-sensitive, character-for-character verbatim substring of the essay text.
- "suggested" is your rewrite of that same sentence.
- "reasoning" is a non-empty string explaining the change.
- Rewrite only existing sentences. NEVER invent, add, or suggest brand-new sentences or content that is not already present in the essay.

CLAIMS RULE

Provide "claims" as a JSON array of opaque Claim_Id strings generated during the evaluation. Output each Claim_Id as a plain string only. Do NOT resolve, match, look up, or validate any Claim_Id against any external resource hub — the frontend consumer performs all matching and resolution. WHEN no claim applies, set "claims" to an empty array.

OUTPUT RULES

Output ONLY valid JSON. No markdown formatting, no code fences, no preambles, no explanations, and no trailing text. Your ENTIRE response MUST be a single JSON object: the first character you output MUST be "{" and the last character MUST be "}". Do NOT write anything before the opening brace or after the closing brace. Do NOT include a "band" field; the band is computed separately and MUST NOT appear in your response.

You MUST produce strictly valid JSON (RFC 8259). You MUST properly escape every special character INSIDE your JSON string values: write a double quote as \\", a backslash as \\\\, and a line break as \\n. Do NOT use literal line breaks, tabs, or unescaped double quotes inside any string value. Keep each string on a single line. This applies to EVERY string, including spans and revision text copied from the essay — if the essay text you quote contains a line break or a double quote, escape it as \\n or \\" so the JSON stays valid.

The JSON object must match this exact schema:

{
  "dimensions": {
    "focus": { "score": <number>, "span": "<string>", "reasoning": "<string>" },
    "specificity": { "score": <number>, "span": "<string>", "reasoning": "<string>" },
    "character": { "score": <number>, "span": "<string>", "reasoning": "<string>" },
    "how_you_think": { "score": <number>, "span": "<string>", "reasoning": "<string>" },
    "contribution": { "score": <number>, "span": "<string>", "reasoning": "<string>" },
    "self_awareness": { "score": <number>, "span": "<string>", "reasoning": "<string>" }
  },
  "mechanics_pass": <boolean>,
  "mechanics_errors": [ "<string>", ... ],
  "revisions": [
    { "original": "<string>", "suggested": "<string>", "reasoning": "<string>" },
    { "original": "<string>", "suggested": "<string>", "reasoning": "<string>" },
    { "original": "<string>", "suggested": "<string>", "reasoning": "<string>" }
  ],
  "claims": [ "<string>", ... ]
}

- "dimensions" MUST contain exactly the six keys focus, specificity, character, how_you_think, contribution, and self_awareness, and no others.
- Every dimension "score" MUST be a finite number >= 0 and <= that dimension's base value; every "span" and "reasoning" MUST be a non-empty string.
- "mechanics_pass" MUST be a JSON boolean; "mechanics_errors" MUST be an array of strings consistent with the mechanics rule above.
- "revisions" MUST contain EXACTLY three objects, each with string "original", "suggested", and "reasoning", and each "original" an exact substring of the essay.
- "claims" MUST be an array of strings (possibly empty).
- Do NOT include any "band" field or any key not listed in this schema.`;

/** Maximum accepted essay length, in characters (Req 1.1). */
export const MAX_ESSAY_LENGTH = 20_000;

/**
 * Maximum number of LLM invoke attempts for a single evaluation: the initial
 * request plus up to two retries (Req 6.3, 7.4). Only a span/revision fault
 * consumes a retry; JSON syntax, schema, timeout, and transport faults are not
 * retried.
 */
const MAX_ATTEMPTS = 3;

/** The six dimension keys, in canonical order (Req 1.5). Exported for testability. */
export const DIMENSION_KEYS = [
  "focus",
  "specificity",
  "character",
  "how_you_think",
  "contribution",
  "self_awareness",
];

/**
 * Base value (pre-modifier maximum) for each dimension (Req 3). The map sums to
 * 115, which is the Total_Score maximum (Req 14.1).
 */
export const BASE_VALUES = {
  focus: 25,
  specificity: 25,
  character: 20,
  how_you_think: 20,
  contribution: 15,
  self_awareness: 10,
};

/**
 * Thrown when the supplied essay text is empty or whitespace-only, before any
 * LLM request is made (Req 2.1).
 */
export class EssayRequiredError extends Error {
  constructor(message = "Essay_Text is required and must contain at least one non-whitespace character.") {
    super(message);
    this.name = "EssayRequiredError";
  }
}

/**
 * Thrown when the LLM request fails with a non-timeout transport error or
 * rejection and the evaluation could not be completed (Req 12.1).
 */
export class EvaluationFailedError extends Error {
  constructor(message = "The evaluation could not be completed because the LLM request failed.") {
    super(message);
    this.name = "EvaluationFailedError";
  }
}

/**
 * Thrown when the LLM does not return a response within the 30 second timeout
 * (Req 11.2, 11.3).
 */
export class EvaluationTimeoutError extends Error {
  constructor(
    message = `The evaluation could not be completed: the LLM did not respond within ${LLM_TIMEOUT_MS}ms.`
  ) {
    super(message);
    this.name = "EvaluationTimeoutError";
  }
}

/**
 * Thrown when the LLM response is not well-formed JSON, is missing a required
 * field, has a wrong-typed or otherwise invalid field, or has spans/revisions
 * that remain invalid after retries are exhausted (Req 6.4, 7.5, 13.2-13.4).
 */
export class InvalidResponseError extends Error {
  constructor(message = "The LLM evaluation response is invalid.") {
    super(message);
    this.name = "InvalidResponseError";
  }
}

/**
 * Injectable dependency boundary for the concrete Kiro LLM call (Req 10.1-10.3).
 *
 * This project has no confirmed Kiro LLM SDK binding available (there is no
 * package.json / node_modules), so the real model call is isolated behind this
 * single module-level function. The timeout and error-handling wrapper in
 * {@link invokeLlm} delegates here, which keeps that wrapper fully implemented
 * and testable while the concrete SDK binding remains a stub. Tests (and the
 * eventual real integration) override this via {@link setLlmCall}.
 *
 * See design.md — "LLM seam": the default implementation should use Kiro's LLM
 * capability; this function is exactly where that call belongs.
 *
 * @param {{ systemPrompt: string, userText: string }} req The assembled request
 *   payload (system prompt + user text).
 * @param {AbortSignal} signal An AbortSignal that is aborted when the 30 second
 *   timeout elapses; a real SDK binding SHOULD forward it so an in-flight call
 *   is cancelled on timeout.
 * @returns {Promise<string>} A promise resolving to the raw text returned by the LLM.
 */
let llmCall = async (_req, _signal) => {
  // TODO(evaluator): Replace this stub with the real Kiro LLM SDK call.
  // The concrete binding is not available in this project yet. When wiring the
  // real model, send `_req.systemPrompt` as the system message and
  // `_req.userText` as the user message, forward `_signal` to the SDK so the
  // request is cancelled on timeout, and return the model's raw text response.
  throw new Error(
    "The Kiro LLM SDK binding is not configured. Inject a real implementation via setLlmCall()."
  );
};

/**
 * Overrides the module-level LLM call used by {@link invokeLlm}. This is the
 * injectable seam that lets tests substitute a mock — or that lets the real
 * Kiro LLM SDK binding be plugged in — without touching the timeout and
 * error-handling wrapper.
 *
 * @param {(req: { systemPrompt: string, userText: string }, signal: AbortSignal) => Promise<string>} impl
 *   The implementation to use for subsequent LLM calls. It receives the request
 *   payload and an AbortSignal that fires on timeout.
 */
export function setLlmCall(impl) {
  llmCall = impl;
}

/**
 * Default LLM seam implementation and the default LlmInvoker. Sends the
 * assembled request to the injectable {@link llmCall} boundary and enforces the
 * response timeout in code via `Promise.race` against a timer, aborting the
 * underlying call through an AbortSignal when the timer wins.
 *
 * Mirrors `shape-classifier.ts`'s `invokeLlm` exactly, with this module's error
 * classes. Failure mapping (Req 11.2, 11.3, 12.1):
 * - If the timer wins the race, the promise rejects with
 *   {@link EvaluationTimeoutError} and the in-flight call is aborted.
 * - An {@link EvaluationTimeoutError} raised by the timer passes through
 *   unchanged.
 * - If the underlying call rejects for any other reason (transport error or an
 *   SDK rejection), the failure surfaces as {@link EvaluationFailedError}.
 *
 * @param {{ systemPrompt: string, userText: string }} req The assembled request
 *   payload (system prompt + user text).
 * @param {number} timeoutMs The maximum time, in milliseconds, to wait for a response.
 * @returns {Promise<string>} A promise resolving to the raw text returned by the LLM.
 * @throws {EvaluationTimeoutError} When no response arrives within `timeoutMs`.
 * @throws {EvaluationFailedError} When the underlying LLM call fails.
 */
const invokeLlm = async (req, timeoutMs) => {
  const controller = new AbortController();
  let timer;

  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EvaluationTimeoutError());
    }, timeoutMs);
  });

  // Surface any underlying-call failure as EvaluationFailedError, while letting
  // an EvaluationTimeoutError from the timer pass through unchanged.
  const call = (async () => {
    try {
      return await llmCall(req, controller.signal);
    } catch (error) {
      if (error instanceof EvaluationTimeoutError) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new EvaluationFailedError(
        `The evaluation could not be completed because the LLM request failed: ${detail}`
      );
    }
  })();

  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

/**
 * Validates that the supplied essay text is within the accepted input range:
 * it contains at least one non-whitespace character and is at most
 * {@link MAX_ESSAY_LENGTH} characters long. Runs before {@link buildMessages}
 * and any LLM request so that input outside the accepted range (an empty,
 * whitespace-only, or over-length essay) never incurs a network call
 * (Req 1.1, 2.1).
 *
 * Mirrors `shape-classifier.ts`'s `assertNonEmptyEssay`, but throws this
 * module's {@link EssayRequiredError} and additionally enforces the
 * {@link MAX_ESSAY_LENGTH} upper bound from Req 1.1.
 *
 * @param {string} essayText The raw student essay text to validate.
 * @throws {EssayRequiredError} When `essayText` is empty, consists solely of
 *   whitespace characters, or exceeds {@link MAX_ESSAY_LENGTH} characters.
 */
function assertNonEmptyEssay(essayText) {
  if (essayText.trim().length === 0) {
    throw new EssayRequiredError();
  }
  if (essayText.length > MAX_ESSAY_LENGTH) {
    throw new EssayRequiredError(
      `Essay_Text must be at most ${MAX_ESSAY_LENGTH} characters long, ` +
        `but was ${essayText.length} characters.`
    );
  }
}

/**
 * Marker line prefix that precedes the shape value in the assembled user
 * message. The {@link SYSTEM_PROMPT} instructs the model to read the line
 * beginning with `"SHAPE:"` to select the linear vs. motif Focus anchors
 * (Req 5.1-5.3).
 */
const SHAPE_MARKER_PREFIX = "SHAPE:";

/**
 * Delimiter line that separates the `SHAPE` marker from the verbatim essay
 * body in the assembled user message. The {@link SYSTEM_PROMPT} instructs the
 * model to treat everything after this delimiter as the exact essay text, so
 * every span and revision `original` is an exact substring of the original
 * `essayText`.
 */
const ESSAY_DELIMITER = "ESSAY:";

/**
 * Assembles the request payload sent to the LLM seam. Pairs the fixed
 * {@link SYSTEM_PROMPT} (which encodes every scoring rule and both Focus anchor
 * sets) with a user message that carries an explicit `SHAPE` marker reflecting
 * the supplied `shape` followed by the verbatim essay body (Req 5.1-5.3,
 * 10.4).
 *
 * The user text is structured as three parts:
 *
 * 1. A marker line `SHAPE: <shape>` (e.g. `SHAPE: linear` or `SHAPE: motif`),
 *    which the system prompt reads to select the linear or motif Focus anchors.
 * 2. An {@link ESSAY_DELIMITER} line marking the start of the essay body.
 * 3. The `essayText` appended EXACTLY as supplied, unmodified.
 *
 * Because the essay body is appended verbatim, the later deterministic span and
 * revision validation (`validateSpansAndRevisions`) can check each span and
 * revision `original` against the original `essayText` — the prefixed marker
 * and delimiter never alter the essay's characters. This stage is pure: it
 * performs no I/O and simply shapes the inputs into an LlmRequest.
 *
 * @param {string} essayText The raw student essay text to evaluate, appended verbatim.
 * @param {"linear" | "motif"} shape The narrative shape sourced from
 *   `classifyShape`; selects which Focus anchor set the model applies.
 * @returns {{ systemPrompt: string, userText: string }} An LlmRequest carrying
 *   the {@link SYSTEM_PROMPT} and the assembled user text (shape marker +
 *   delimiter + verbatim essay body).
 */
function buildMessages(essayText, shape) {
  return {
    systemPrompt: SYSTEM_PROMPT,
    userText: `${SHAPE_MARKER_PREFIX} ${shape}\n${ESSAY_DELIMITER}\n${essayText}`,
  };
}

/**
 * Parses the raw text returned by the LLM into a JSON value. This is the
 * parsing stage of the pipeline (Req 13.1), kept separate from schema
 * validation (`validateLlmEvaluation`) so that a JSON syntax error produces a
 * distinct, specific error from a schema violation.
 *
 * Mirrors `shape-classifier.ts`'s `parseResponse`, but throws this module's
 * {@link InvalidResponseError}.
 *
 * @param {string} raw The raw text returned by the LLM, expected to contain a
 *   JSON object.
 * @returns {unknown} The parsed JSON value; the caller narrows it to an
 *   LlmEvaluation via `validateLlmEvaluation`.
 * @throws {InvalidResponseError} When `raw` is not well-formed JSON (Req 13.2).
 *   The error message identifies the underlying JSON syntax fault.
 */
function parseResponse(raw) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    // Log the exact raw text the LLM returned before throwing, so a parse
    // failure is diagnosable from the browser console.
    if (typeof console !== "undefined" && typeof console.error === "function") {
      console.error(
        "[evaluator] Failed to JSON.parse the LLM response. Raw text:\n%s",
        raw
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new InvalidResponseError(
      `The LLM evaluation response is not well-formed JSON: ${detail}`
    );
  }
}

/**
 * Produces a short, human-readable description of a value's runtime type for
 * use in validation error messages (e.g. "number", "null", "array",
 * "object"). This lets {@link validateLlmEvaluation} name both the invalid
 * value and its type when a field is wrong-typed. Mirrors
 * `shape-classifier.ts`'s `describeType`.
 *
 * @param {unknown} value The value to describe.
 * @returns {string} A concise type label.
 */
function describeType(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

/**
 * Asserts that a value is a plain, non-null, non-array object and narrows it to
 * a string-keyed record. Used for the top-level response object and for each
 * nested dimension and revision entry.
 *
 * @param {unknown} value The value to test.
 * @returns {boolean} `true` when `value` is a non-null, non-array object.
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strictly validates a parsed JSON value and narrows it to an LlmEvaluation.
 * This is the authoritative schema guard for the LLM's evaluation output: it
 * performs NO coercion and NO defaulting (Req 13.6). A wrong-typed field (for
 * example `mechanics_pass` as the number `1` or the string `"true"`, a
 * dimension `score` as a string, or `claims` containing a non-string) is
 * rejected outright rather than repaired. Checks run in order so the thrown
 * {@link InvalidResponseError} always names the FIRST fault encountered — the
 * first missing field, or the first wrong-typed field and its value
 * (Req 13.3, 13.4).
 *
 * The `band` field is NEVER read or parsed from the response: the evaluator
 * computes the band deterministically from the finalized dimension scores
 * (Req 13.5). An LLM-supplied `band` is simply ignored here.
 *
 * Validation order (Req 8.1-8.4, 9.1, 13.1):
 *
 * 1. `value` is a non-null, non-array object.
 * 2. `dimensions` is present and is an object containing EXACTLY the six
 *    canonical keys (no missing, no extra); each entry is an object with a
 *    finite `score >= 0`, a non-empty `span` string, and a non-empty
 *    `reasoning` string.
 * 3. `mechanics_pass` is present and strictly a boolean (no `0`/`1`/`"true"`
 *    coercion).
 * 4. `mechanics_errors` is present and an array of strings.
 * 5. Mechanics consistency: `mechanics_errors` is empty when `mechanics_pass`
 *    is `true`, and contains at least one string when it is `false`.
 * 6. `revisions` is present and an array; each entry is an object with string
 *    `original`, `suggested`, and `reasoning`. (The exactly-three count and the
 *    substring checks are enforced later by `validateSpansAndRevisions`.)
 * 7. `claims` is present and an array of strings.
 *
 * @param {unknown} value The parsed JSON value produced by {@link parseResponse}.
 * @returns {{ mechanics_pass: boolean, mechanics_errors: string[], dimensions: object, revisions: object[], claims: string[] }}
 *   The value narrowed to an LlmEvaluation.
 * @throws {InvalidResponseError} When `value` is not an object, or any field is
 *   missing, wrong-typed, or inconsistent. The message names the specific fault
 *   and, for a wrong type, the offending value.
 */
function validateLlmEvaluation(value) {
  // 1. Must be a non-null, non-array object.
  if (!isPlainObject(value)) {
    throw new InvalidResponseError(
      `The LLM evaluation response must be a JSON object but was of type ${describeType(value)}.`
    );
  }

  // 2. `dimensions` must exist, be an object, and contain exactly the six keys.
  if (!("dimensions" in value)) {
    throw new InvalidResponseError(
      'The LLM evaluation response is missing the required field "dimensions".'
    );
  }
  const dimensionsValue = value.dimensions;
  if (!isPlainObject(dimensionsValue)) {
    throw new InvalidResponseError(
      `The LLM evaluation response has an invalid "dimensions" value: ${JSON.stringify(dimensionsValue)} ` +
        `(type ${describeType(dimensionsValue)}). It must be an object with exactly the six dimension keys.`
    );
  }

  // Reject any extra key not among the canonical six.
  const actualKeys = Object.keys(dimensionsValue);
  for (const key of actualKeys) {
    if (!DIMENSION_KEYS.includes(key)) {
      throw new InvalidResponseError(
        `The LLM evaluation response "dimensions" contains an unexpected key "${key}". ` +
          `It must contain exactly the six keys ${DIMENSION_KEYS.map((k) => `"${k}"`).join(", ")} and no others.`
      );
    }
  }

  // Validate each of the six dimensions in canonical order; name the first fault.
  for (const key of DIMENSION_KEYS) {
    if (!(key in dimensionsValue)) {
      throw new InvalidResponseError(
        `The LLM evaluation response "dimensions" is missing the required dimension "${key}".`
      );
    }
    const entry = dimensionsValue[key];
    if (!isPlainObject(entry)) {
      throw new InvalidResponseError(
        `The LLM evaluation response dimension "${key}" is invalid: ${JSON.stringify(entry)} ` +
          `(type ${describeType(entry)}). It must be an object with a "score", "span", and "reasoning".`
      );
    }

    // `score`: present, strictly a finite number >= 0 (no coercion).
    if (!("score" in entry)) {
      throw new InvalidResponseError(
        `The LLM evaluation response dimension "${key}" is missing the required field "score".`
      );
    }
    const score = entry.score;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new InvalidResponseError(
        `The LLM evaluation response dimension "${key}" has an invalid "score" value: ${JSON.stringify(score)} ` +
          `(type ${describeType(score)}). It must be a finite number >= 0.`
      );
    }
    if (score < 0) {
      throw new InvalidResponseError(
        `The LLM evaluation response dimension "${key}" has an invalid "score" value: ${score}. ` +
          `It must be a finite number >= 0.`
      );
    }

    // `span`: present, strictly a non-empty string.
    if (!("span" in entry)) {
      throw new InvalidResponseError(
        `The LLM evaluation response dimension "${key}" is missing the required field "span".`
      );
    }
    const span = entry.span;
    if (typeof span !== "string") {
      throw new InvalidResponseError(
        `The LLM evaluation response dimension "${key}" has an invalid "span" value: ${JSON.stringify(span)} ` +
          `(type ${describeType(span)}). It must be a non-empty string.`
      );
    }
    if (span.length === 0) {
      throw new InvalidResponseError(
        `The LLM evaluation response dimension "${key}" has an invalid "span" value: it must be a non-empty string.`
      );
    }

    // `reasoning`: present, strictly a non-empty string.
    if (!("reasoning" in entry)) {
      throw new InvalidResponseError(
        `The LLM evaluation response dimension "${key}" is missing the required field "reasoning".`
      );
    }
    const reasoning = entry.reasoning;
    if (typeof reasoning !== "string") {
      throw new InvalidResponseError(
        `The LLM evaluation response dimension "${key}" has an invalid "reasoning" value: ${JSON.stringify(reasoning)} ` +
          `(type ${describeType(reasoning)}). It must be a non-empty string.`
      );
    }
    if (reasoning.length === 0) {
      throw new InvalidResponseError(
        `The LLM evaluation response dimension "${key}" has an invalid "reasoning" value: ` +
          `it must be a non-empty string.`
      );
    }
  }

  // 3. `mechanics_pass` must exist and be strictly a boolean (no coercion).
  if (!("mechanics_pass" in value)) {
    throw new InvalidResponseError(
      'The LLM evaluation response is missing the required field "mechanics_pass".'
    );
  }
  const mechanicsPass = value.mechanics_pass;
  if (typeof mechanicsPass !== "boolean") {
    throw new InvalidResponseError(
      `The LLM evaluation response has an invalid "mechanics_pass" value: ${JSON.stringify(mechanicsPass)} ` +
        `(type ${describeType(mechanicsPass)}). It must be a JSON boolean (true or false), ` +
        `never a number, string, null, or object.`
    );
  }

  // 4. `mechanics_errors` must exist and be an array of strings.
  if (!("mechanics_errors" in value)) {
    throw new InvalidResponseError(
      'The LLM evaluation response is missing the required field "mechanics_errors".'
    );
  }
  const mechanicsErrors = value.mechanics_errors;
  if (!Array.isArray(mechanicsErrors)) {
    throw new InvalidResponseError(
      `The LLM evaluation response has an invalid "mechanics_errors" value: ${JSON.stringify(mechanicsErrors)} ` +
        `(type ${describeType(mechanicsErrors)}). It must be an array of strings.`
    );
  }
  for (let i = 0; i < mechanicsErrors.length; i++) {
    const item = mechanicsErrors[i];
    if (typeof item !== "string") {
      throw new InvalidResponseError(
        `The LLM evaluation response "mechanics_errors" has an invalid element at index ${i}: ${JSON.stringify(item)} ` +
          `(type ${describeType(item)}). Every element must be a string.`
      );
    }
  }

  // 5. Mechanics consistency: pass true => empty errors; pass false => >= 1 error.
  if (mechanicsPass && mechanicsErrors.length !== 0) {
    throw new InvalidResponseError(
      `The LLM evaluation response is inconsistent: "mechanics_pass" is true but "mechanics_errors" is ` +
        `non-empty (${mechanicsErrors.length} entries). When "mechanics_pass" is true, "mechanics_errors" must be empty.`
    );
  }
  if (!mechanicsPass && mechanicsErrors.length === 0) {
    throw new InvalidResponseError(
      `The LLM evaluation response is inconsistent: "mechanics_pass" is false but "mechanics_errors" is empty. ` +
        `When "mechanics_pass" is false, "mechanics_errors" must contain at least one string.`
    );
  }

  // 6. `revisions` must exist and be an array of {original, suggested, reasoning}
  //    string objects. The exactly-three count and the substring checks are
  //    enforced later by `validateSpansAndRevisions` (Task 6), NOT here.
  if (!("revisions" in value)) {
    throw new InvalidResponseError(
      'The LLM evaluation response is missing the required field "revisions".'
    );
  }
  const revisions = value.revisions;
  if (!Array.isArray(revisions)) {
    throw new InvalidResponseError(
      `The LLM evaluation response has an invalid "revisions" value: ${JSON.stringify(revisions)} ` +
        `(type ${describeType(revisions)}). It must be an array.`
    );
  }
  for (let i = 0; i < revisions.length; i++) {
    const revision = revisions[i];
    if (!isPlainObject(revision)) {
      throw new InvalidResponseError(
        `The LLM evaluation response "revisions" has an invalid element at index ${i}: ${JSON.stringify(revision)} ` +
          `(type ${describeType(revision)}). Every element must be an object with "original", "suggested", and "reasoning".`
      );
    }
    for (const field of ["original", "suggested", "reasoning"]) {
      if (!(field in revision)) {
        throw new InvalidResponseError(
          `The LLM evaluation response "revisions" element at index ${i} is missing the required field "${field}".`
        );
      }
      const fieldValue = revision[field];
      if (typeof fieldValue !== "string") {
        throw new InvalidResponseError(
          `The LLM evaluation response "revisions" element at index ${i} has an invalid "${field}" value: ` +
            `${JSON.stringify(fieldValue)} (type ${describeType(fieldValue)}). It must be a string.`
        );
      }
    }
  }

  // 7. `claims` must exist and be an array of strings.
  if (!("claims" in value)) {
    throw new InvalidResponseError(
      'The LLM evaluation response is missing the required field "claims".'
    );
  }
  const claims = value.claims;
  if (!Array.isArray(claims)) {
    throw new InvalidResponseError(
      `The LLM evaluation response has an invalid "claims" value: ${JSON.stringify(claims)} ` +
        `(type ${describeType(claims)}). It must be an array of strings.`
    );
  }
  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    if (typeof claim !== "string") {
      throw new InvalidResponseError(
        `The LLM evaluation response "claims" has an invalid element at index ${i}: ${JSON.stringify(claim)} ` +
          `(type ${describeType(claim)}). Every element must be a string.`
      );
    }
  }

  // All checks passed: narrow to LlmEvaluation. `band` is never read (Req 13.5).
  return {
    mechanics_pass: mechanicsPass,
    mechanics_errors: mechanicsErrors,
    dimensions: dimensionsValue,
    revisions: revisions,
    claims: claims,
  };
}

/**
 * Deterministically validates the verbatim-span and exactly-three-revisions
 * rules against the original essay text. This stage runs AFTER
 * {@link validateLlmEvaluation} has narrowed the response to an LlmEvaluation,
 * and it is the gate for the retry loop: unlike a JSON syntax fault or a schema
 * fault (which surface immediately), a span/revision fault is a
 * plausibly-recoverable anchoring mistake that the loop may retry
 * (Req 6.3, 6.5, 7.4, 7.6, 7.7).
 *
 * The validation is entirely independent of the LLM — it compares the response
 * fields against `essayText` using exact, case-sensitive, character-for-character
 * substring checks (`essayText.includes(...)`), preserving the essay's original
 * whitespace and punctuation. It performs the following checks in order and
 * reports the FIRST fault it finds:
 *
 * 1. For each of the six dimensions (in canonical {@link DIMENSION_KEYS} order),
 *    `span` must be a non-empty string that is an exact substring of `essayText`
 *    (Req 6.1, 6.2).
 * 2. `revisions` must contain EXACTLY three entries — no more, no fewer
 *    (Req 7.1).
 * 3. Each revision's `original` must be an exact substring of `essayText`
 *    (Req 7.3).
 *
 * This function NEVER throws for a span/revision fault. Instead it returns a
 * SpanRevisionOutcome: `{ valid: true }` when every check passes, or
 * `{ valid: false, reason }` where `reason` names the offending dimension or
 * revision and reports the invalid value so the caller can surface a precise
 * {@link InvalidResponseError} on retry exhaustion (Req 6.4, 7.5).
 *
 * @param {{ dimensions: object, revisions: object[] }} llm The schema-validated
 *   LLM evaluation (output of {@link validateLlmEvaluation}).
 * @param {string} essayText The original, verbatim essay text that every span
 *   and revision `original` must be an exact substring of.
 * @returns {{ valid: true } | { valid: false, reason: string }} A
 *   SpanRevisionOutcome describing whether the spans and revisions are valid
 *   and, if not, why.
 */
function validateSpansAndRevisions(llm, essayText) {
  // 1. Each of the six dimension spans must be a non-empty string that LOCATES
  //    in the essay — exactly, or after whitespace/punctuation normalization.
  //    When it locates only after normalization, the span is rewritten IN PLACE
  //    to the exact verbatim essay slice so the stored result stays verbatim and
  //    the frontend highlighter (which uses essayText.indexOf) still lands on
  //    real text (Req 6.1, 6.2, relaxed to tolerate minor quote differences).
  for (const key of DIMENSION_KEYS) {
    const span = llm.dimensions[key].span;
    if (typeof span !== "string" || span.length === 0) {
      return {
        valid: false,
        reason:
          `Dimension "${key}" has an invalid span: it must be a non-empty string, ` +
          `but was ${JSON.stringify(span)}.`,
      };
    }
    const located = locateSpanInEssay(span, essayText);
    if (located === null) {
      return {
        valid: false,
        reason:
          `Dimension "${key}" has a span that could not be located in the essay even ` +
          `after normalizing whitespace and punctuation: ${JSON.stringify(span)}.`,
      };
    }
    // Normalize the stored span to the exact essay slice it matched.
    llm.dimensions[key].span = located;
  }

  // 2. `revisions` must contain exactly three entries (Req 7.1).
  if (llm.revisions.length !== 3) {
    return {
      valid: false,
      reason:
        `The "revisions" array must contain exactly three entries, but contained ` +
        `${llm.revisions.length}.`,
    };
  }

  // 3. Each revision's `original` must locate in the essay — exactly, or after
  //    whitespace/punctuation normalization — and is rewritten IN PLACE to the
  //    exact verbatim essay slice when it matches only after normalization
  //    (Req 7.3, relaxed to tolerate minor quote differences).
  for (let i = 0; i < llm.revisions.length; i++) {
    const original = llm.revisions[i].original;
    if (typeof original !== "string" || original.length === 0) {
      return {
        valid: false,
        reason:
          `Revision at index ${i} has an invalid "original": it must be a non-empty string, ` +
          `but was ${JSON.stringify(original)}.`,
      };
    }
    const located = locateSpanInEssay(original, essayText);
    if (located === null) {
      return {
        valid: false,
        reason:
          `Revision at index ${i} has an "original" that could not be located in the essay ` +
          `even after normalizing whitespace and punctuation: ${JSON.stringify(original)}.`,
      };
    }
    // Normalize the stored original to the exact essay slice it matched.
    llm.revisions[i].original = located;
  }

  return { valid: true };
}

/**
 * Locates a model-supplied quote inside the essay, tolerating minor differences
 * in whitespace and punctuation so the evaluator stops rejecting otherwise-good
 * output over a trivially re-quoted span.
 *
 * Matching proceeds from strict to lenient and ALWAYS returns a VERBATIM slice
 * of `essayText` (never the model's possibly-altered string), so the stored
 * span/original stays an exact essay substring and the frontend highlighter
 * (which uses `essayText.indexOf`) lands on real text:
 *
 *   1. Exact match: if `essayText` already includes `quote`, return `quote`.
 *   2. Normalized match: normalize both the essay and the quote by collapsing
 *      runs of whitespace to a single space, unifying common "smart"
 *      punctuation (curly quotes/apostrophes, en/em dashes, ellipsis) to ASCII,
 *      and dropping a trailing sentence punctuation mark. If the normalized
 *      quote appears in the normalized essay, map the normalized match span back
 *      to the corresponding range in the ORIGINAL essay and return that exact
 *      slice.
 *
 * Returns `null` when no exact or normalized match exists.
 *
 * @param {string} quote The model-supplied span or revision original.
 * @param {string} essayText The original, verbatim essay text.
 * @returns {string | null} The exact verbatim essay slice that matched, or null.
 */
function locateSpanInEssay(quote, essayText) {
  // 1. Fast path — an exact, character-for-character substring.
  if (essayText.includes(quote)) {
    return quote;
  }

  // 2. Normalized path. Build a normalized essay string alongside an index map
  //    from each normalized-string position back to its source index in the
  //    ORIGINAL essay, so a normalized match can be mapped to an exact slice.
  const { normalized: normEssay, map } = normalizeWithIndexMap(essayText);
  const { normalized: normQuoteRaw } = normalizeWithIndexMap(quote);
  const normQuote = normQuoteRaw.trim();

  if (normQuote.length === 0) {
    return null;
  }

  const at = normEssay.indexOf(normQuote);
  if (at === -1) {
    return null;
  }

  // Map the normalized [at, at + len) range back to original-essay indices.
  const startOrig = map[at];
  const endOrig = map[at + normQuote.length - 1];
  if (startOrig === undefined || endOrig === undefined) {
    return null;
  }
  return essayText.slice(startOrig, endOrig + 1);
}

/**
 * Normalizes text for lenient span matching and returns both the normalized
 * string and an index map: `map[i]` is the index in the ORIGINAL `text` of the
 * character that produced `normalized[i]`. Normalization unifies smart
 * punctuation to ASCII and collapses each run of whitespace to a single space
 * (mapped to the first whitespace character of the run), so a normalized match
 * can be mapped back to an exact original slice.
 *
 * @param {string} text
 * @returns {{ normalized: string, map: number[] }}
 */
function normalizeWithIndexMap(text) {
  const normalizedChars = [];
  const map = [];

  let inWhitespace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      // Collapse a run of whitespace into a single space, anchored to the run's
      // first character so the mapped original range stays contiguous.
      if (!inWhitespace) {
        normalizedChars.push(" ");
        map.push(i);
        inWhitespace = true;
      }
      continue;
    }
    inWhitespace = false;

    // Unify common "smart" punctuation to its ASCII equivalent.
    let out = ch;
    if (ch === "\u2018" || ch === "\u2019" || ch === "\u02BC") {
      out = "'"; // curly single quotes / modifier apostrophe
    } else if (ch === "\u201C" || ch === "\u201D") {
      out = '"'; // curly double quotes
    } else if (ch === "\u2013" || ch === "\u2014" || ch === "\u2212") {
      out = "-"; // en dash / em dash / minus
    } else if (ch === "\u2026") {
      out = "..."; // ellipsis → three dots (each mapped to the same source index)
      for (let k = 0; k < 3; k++) {
        normalizedChars.push(".");
        map.push(i);
      }
      continue;
    }

    normalizedChars.push(out);
    map.push(i);
  }

  return { normalized: normalizedChars.join(""), map };
}

/**
 * Derives the base-value dimension scores from the schema-validated LLM
 * evaluation (Req 4.1 precursor, Req 3). This is the first deterministic
 * scoring stage: it takes the per-dimension `score`, `span`, and `reasoning`
 * exactly as the LLM supplied them (already narrowed and range-checked by
 * {@link validateLlmEvaluation}) and assembles them into a fresh DimensionScores
 * object containing exactly the six canonical dimensions in
 * {@link DIMENSION_KEYS} order (Req 1.5).
 *
 * These are the "base-value" scores — the raw rubric scores against each
 * dimension's {@link BASE_VALUES} maximum, BEFORE any profile modifier is
 * applied. {@link applyProfileModifiers} consumes this result to produce the
 * finalized scores.
 *
 * The function is pure and does not mutate `llm`: every dimension entry is
 * copied into a new object, so the returned DimensionScores shares no references
 * with the input that a later stage could accidentally mutate.
 *
 * @param {{ dimensions: object }} llm The schema-validated LLM evaluation
 *   (output of {@link validateLlmEvaluation}).
 * @returns {object} A new DimensionScores carrying each dimension's base-value
 *   `score`, verbatim `span`, and `reasoning`.
 */
export function scoreDimensions(llm) {
  const source = llm.dimensions;
  return {
    focus: {
      score: source.focus.score,
      span: source.focus.span,
      reasoning: source.focus.reasoning,
    },
    specificity: {
      score: source.specificity.score,
      span: source.specificity.span,
      reasoning: source.specificity.reasoning,
    },
    character: {
      score: source.character.score,
      span: source.character.span,
      reasoning: source.character.reasoning,
    },
    how_you_think: {
      score: source.how_you_think.score,
      span: source.how_you_think.span,
      reasoning: source.how_you_think.reasoning,
    },
    contribution: {
      score: source.contribution.score,
      span: source.contribution.span,
      reasoning: source.contribution.reasoning,
    },
    self_awareness: {
      score: source.self_awareness.score,
      span: source.self_awareness.span,
      reasoning: source.self_awareness.reasoning,
    },
  };
}

/**
 * Applies the intake Profile_Modifiers to the base-value dimension scores
 * (Req 4). This is the second deterministic scoring stage: it adjusts the
 * scores produced by {@link scoreDimensions} according to the applicant's
 * context, then the result flows to `computeTotalScore` / `deriveBand`.
 *
 * `router.ts` emits modifier keys in title case (for example `"Character"` and
 * `"Contribution"`), while the dimension keys are lowercase. The match bridges
 * that gap: each modifier key is lowercased and compared against
 * {@link DIMENSION_KEYS} (Req 4.2). For a matching key the numeric value is
 * ADDED to that dimension's score and the result is CLAMPED to the inclusive
 * range `[0, BASE_VALUES[key]]` (Req 4.3). A modifier key that matches no
 * dimension leaves every score unchanged for that key (Req 4.4), and an empty
 * `profileModifiers` map leaves every dimension at its base-value score
 * (Req 4.5).
 *
 * Only the `score` is adjusted; each dimension's `span` and `reasoning` are
 * preserved exactly. The function is pure: it builds and returns a NEW
 * DimensionScores and never mutates the `dimensions` argument.
 *
 * When two modifier keys map to the same dimension by case-insensitive match
 * (for example both `"Character"` and `"character"`), they are applied in
 * iteration order and each adds onto the running (already-clamped) score, so
 * the net effect is cumulative and the final score still lies within
 * `[0, BASE_VALUES[key]]`.
 *
 * @param {object} dimensions The base-value dimension scores (output of
 *   {@link scoreDimensions}).
 * @param {Record<string, number>} profileModifiers The per-dimension weight
 *   adjustments, sourced from `router.ts`'s `evaluateProfile` `modifiers` field.
 * @returns {object} A new DimensionScores with each matched dimension's `score`
 *   additively adjusted and clamped, and all `span`/`reasoning` values and
 *   unmatched scores preserved.
 */
export function applyProfileModifiers(dimensions, profileModifiers) {
  // Start from a fresh copy so the input is never mutated (Req 4.5 leaves the
  // base-value scores intact when no modifier applies).
  const result = {
    focus: { ...dimensions.focus },
    specificity: { ...dimensions.specificity },
    character: { ...dimensions.character },
    how_you_think: { ...dimensions.how_you_think },
    contribution: { ...dimensions.contribution },
    self_awareness: { ...dimensions.self_awareness },
  };

  // Set of canonical lowercase dimension keys for the case-insensitive match.
  const canonicalKeys = new Set(DIMENSION_KEYS);

  for (const rawKey of Object.keys(profileModifiers)) {
    const normalizedKey = rawKey.toLowerCase();

    // Req 4.4: a key that matches no dimension changes nothing.
    if (!canonicalKeys.has(normalizedKey)) {
      continue;
    }

    const key = normalizedKey;
    const value = profileModifiers[rawKey];

    // Req 4.2: add the modifier value to the matched dimension's score.
    const adjusted = result[key].score + value;

    // Req 4.3: clamp the result to [0, BASE_VALUES[key]].
    const baseValue = BASE_VALUES[key];
    const clamped = Math.min(Math.max(adjusted, 0), baseValue);

    // Preserve span and reasoning; only the score is adjusted.
    result[key] = {
      score: clamped,
      span: result[key].span,
      reasoning: result[key].reasoning,
    };
  }

  return result;
}

/**
 * Sums the six finalized dimension scores into the essay's `Total_Score`
 * (Req 14.1). The input `dimensions` are the scores AFTER
 * {@link applyProfileModifiers} has run, so each individual score already lies
 * in `[0, BASE_VALUES[key]]`. Because {@link BASE_VALUES} sums to 115, the
 * returned total necessarily lies in `[0, 115]`.
 *
 * This stage is pure: it reads only the supplied scores, iterates the canonical
 * {@link DIMENSION_KEYS} so every dimension is counted exactly once, and
 * performs no I/O and no LLM call.
 *
 * @param {object} dimensions The finalized six-dimension score breakdown.
 * @returns {number} The sum of the six dimension scores, in `[0, 115]`.
 */
export function computeTotalScore(dimensions) {
  let total = 0;
  for (const key of DIMENSION_KEYS) {
    total += dimensions[key].score;
  }
  return total;
}

/**
 * Maps a `Total_Score` onto the overall band `1`–`5` (Req 14.2–14.7). The band
 * scale is five equal 23-point bands spanning the full `0`–`115` range, using
 * inclusive boundaries that match the design's band derivation table exactly:
 *
 * | Total_Score range (inclusive) | band |
 * | ----------------------------- | ---- |
 * | 0 – 23                        | 1    |
 * | 24 – 46                       | 2    |
 * | 47 – 69                       | 3    |
 * | 70 – 92                       | 4    |
 * | 93 – 115                      | 5    |
 *
 * This is a pure function of `totalScore` with NO LLM involvement — the band is
 * computed in code and never read from the model response (Req 13.5, 14.8). The
 * ranges are expressed as explicit inclusive upper bounds so the boundary
 * values (23/24, 46/47, 69/70, 92/93) fall on the exact band the table
 * specifies. A total above 115 (which the clamped scores cannot produce) still
 * maps to band 5.
 *
 * @param {number} totalScore The summed `Total_Score`, expected in `[0, 115]`.
 * @returns {number} The overall band, an integer in `1`–`5`.
 */
export function deriveBand(totalScore) {
  if (totalScore <= 23) {
    return 1;
  }
  if (totalScore <= 46) {
    return 2;
  }
  if (totalScore <= 69) {
    return 3;
  }
  if (totalScore <= 92) {
    return 4;
  }
  return 5;
}

/**
 * Evaluates a student application essay against the EasyDawg rubric using
 * Kiro's LLM, returning a structured, deterministic Evaluation_Result.
 *
 * This is the module's public entry point and the orchestrator that wires the
 * full processing pipeline described in design.md. It runs the stages in this
 * order:
 *
 * 1. {@link assertNonEmptyEssay} — reject an empty, whitespace-only, or
 *    over-length essay BEFORE any LLM request is made (Req 1.1, 2.1). An essay
 *    longer than {@link MAX_ESSAY_LENGTH} characters is rejected as invalid
 *    input, so no network call is incurred for input outside the accepted
 *    range.
 * 2. {@link buildMessages} — assemble the {@link SYSTEM_PROMPT} with the essay
 *    body and the explicit `SHAPE` marker reflecting `shape` (Req 5.1-5.3,
 *    10.4). Built ONCE and reused across every retry attempt.
 * 3. The invoke → parse → schema-validate → span/revision-validate retry loop
 *    (up to {@link MAX_ATTEMPTS} total attempts: the initial request plus two
 *    retries). On each attempt:
 *    - `invoker(request, LLM_TIMEOUT_MS)` sends the request under the 30-second
 *      timeout. An {@link EvaluationTimeoutError} or {@link EvaluationFailedError}
 *      from the invoker propagates out of the loop unchanged — these are NOT
 *      retried (Req 11, 12).
 *    - {@link parseResponse} parses the raw text. A JSON syntax fault throws
 *      {@link InvalidResponseError} IMMEDIATELY and is NOT retried (Req 13.2) —
 *      a malformed response is not a recoverable anchoring mistake.
 *    - {@link validateLlmEvaluation} strictly validates the schema. A missing
 *      or wrong-typed field throws {@link InvalidResponseError} IMMEDIATELY and
 *      is NOT retried (Req 13.3-13.6).
 *    - {@link validateSpansAndRevisions} checks the verbatim-span and
 *      exactly-three-revisions rules against `essayText`. ONLY a span/revision
 *      fault triggers a retry (Req 6.3, 7.4). If retries remain, the loop
 *      requests again; if retries are exhausted and the spans/revisions are
 *      still invalid, the evaluator throws {@link InvalidResponseError} naming
 *      the offending dimension or revision and returns nothing (Req 6.4, 7.5).
 * 4. On an accepted (valid) response, the deterministic scoring runs ONCE:
 *    {@link scoreDimensions} → {@link applyProfileModifiers} →
 *    {@link computeTotalScore} → {@link deriveBand} (Req 3, 4, 14). The band is
 *    computed by the evaluator from the finalized dimension scores and is never
 *    read from the LLM response (Req 13.5, 14.8).
 * 5. The final Evaluation_Result is assembled with the computed `band` plus the
 *    finalized `dimensions` and the LLM-provided `mechanics_pass`,
 *    `mechanics_errors`, `revisions`, and `claims` (Req 1.1).
 *
 * The LLM seam is injectable via the optional `invoker` parameter, which
 * defaults to the production {@link invokeLlm}. Tests supply a mock invoker to
 * exercise the deterministic pipeline and the retry loop without a live model,
 * while the default call path always routes through `invokeLlm` with
 * {@link LLM_TIMEOUT_MS} (Req 10.1).
 *
 * @param {string} essayText The raw student essay text to evaluate. Must contain
 *   at least one non-whitespace character and be at most {@link MAX_ESSAY_LENGTH}
 *   characters long.
 * @param {Record<string, number>} profileModifiers The per-dimension weight
 *   adjustments, sourced from `router.ts`'s `evaluateProfile` `modifiers` field;
 *   keys are matched case-insensitively against the dimension names (Req 4).
 * @param {"linear" | "motif"} shape The narrative shape sourced from
 *   `classifyShape`; selects which Focus anchor set the model applies (Req 5).
 * @param {(req: { systemPrompt: string, userText: string }, timeoutMs: number) => Promise<string>} [invoker]
 *   The LLM seam to use for the request. Defaults to the production
 *   {@link invokeLlm}; override it in tests to inject a mock.
 * @returns {Promise<object>} A promise resolving to the assembled
 *   Evaluation_Result with the deterministically computed `band`.
 * @throws {EssayRequiredError} When `essayText` is empty, whitespace-only, or
 *   longer than {@link MAX_ESSAY_LENGTH}; no LLM request is made (Req 2.1).
 * @throws {EvaluationTimeoutError} When the LLM does not respond within
 *   {@link LLM_TIMEOUT_MS} (Req 11.2, 11.3).
 * @throws {EvaluationFailedError} When the LLM request fails with a non-timeout
 *   transport error or rejection (Req 12.1).
 * @throws {InvalidResponseError} When the response is not well-formed JSON, is
 *   missing or has a wrong-typed required field, or has spans/revisions that
 *   remain invalid after retries are exhausted (Req 6.4, 7.5, 13.2-13.4).
 */
export async function evaluateEssay(
  essayText,
  profileModifiers,
  shape,
  invoker = invokeLlm
) {
  // Stage 1: Fail fast on invalid input before any LLM request (Req 2.1).
  assertNonEmptyEssay(essayText);

  // Stage 2: Assemble the request once; it is reused across every retry attempt.
  const request = buildMessages(essayText, shape);

  // Stage 3: invoke -> parse -> schema-validate -> span/revision-validate,
  // retrying ONLY on a span/revision fault up to MAX_ATTEMPTS total attempts.
  let acceptedLlm;
  let lastSpanRevisionReason = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Timeout/failure errors from the invoker propagate out of the loop; JSON
    // syntax faults (parseResponse) and schema faults (validateLlmEvaluation)
    // throw InvalidResponseError immediately and are NOT caught here, so they
    // propagate without triggering a retry (Req 11, 12, 13.2-13.6).
    const raw = await invoker(request, LLM_TIMEOUT_MS);
    const parsed = parseResponse(raw);
    const llm = validateLlmEvaluation(parsed);

    // Only a span/revision fault is a plausibly-recoverable anchoring mistake
    // that triggers a retry (Req 6.3, 7.4).
    const outcome = validateSpansAndRevisions(llm, essayText);
    if (outcome.valid) {
      acceptedLlm = llm;
      break;
    }

    lastSpanRevisionReason = outcome.reason;
    // Fall through to the next loop iteration if retries remain; when the loop
    // exits without an accepted response, the fault is thrown below.
  }

  // Retries exhausted with spans/revisions still invalid: throw naming the
  // fault and return nothing (Req 6.4, 7.5).
  if (acceptedLlm === undefined) {
    throw new InvalidResponseError(
      `The LLM evaluation response still had invalid spans or revisions after ` +
        `${MAX_ATTEMPTS} attempts: ${lastSpanRevisionReason}`
    );
  }

  // Stage 4: Deterministic scoring runs once on the accepted response (Req 3, 4, 14).
  const baseScores = scoreDimensions(acceptedLlm);
  const finalizedScores = applyProfileModifiers(baseScores, profileModifiers);
  const totalScore = computeTotalScore(finalizedScores);
  const band = deriveBand(totalScore);

  // Stage 5: Assemble the final result with the computed band (Req 1.1, 13.5).
  return {
    band,
    mechanics_pass: acceptedLlm.mechanics_pass,
    mechanics_errors: acceptedLlm.mechanics_errors,
    dimensions: finalizedScores,
    revisions: acceptedLlm.revisions,
    claims: acceptedLlm.claims,
  };
}
