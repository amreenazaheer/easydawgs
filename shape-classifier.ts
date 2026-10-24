/**
 * LLM-backed structural shape classifier for the EasyDawg admissions evaluator.
 *
 * Unlike the deterministic logic in `router.ts`, this module delegates a
 * judgment task — reading a student's application essay and classifying its
 * narrative shape — to Kiro's large language model (LLM). The public entry
 * point is the async `classifyShape` function (added in a later task); this
 * file currently establishes the module's public types, constants, the
 * mockable LLM seam, and the named error model.
 */

/** Allowed values for the essay's narrative shape. */
export type ShapeValue = "linear" | "motif";

/**
 * The structural shape classification produced for an essay.
 */
export interface ClassificationResult {
  /** The narrative shape: "linear" or "motif". */
  shape: ShapeValue;
  /** True when the ending explicitly returns to the exact opening image/scene/question. */
  circularity: boolean;
  /** One short sentence naming the textual evidence for the shape choice. */
  reasoning: string;
}

/** Maximum time to wait for an LLM classification response. */
export const LLM_TIMEOUT_MS = 30_000;

/**
 * Fixed instruction set supplied to the LLM. It encodes every classification
 * rule from Requirement 2 — the linear/motif shape rules and their tie-break
 * and default, the circularity true/false conditions, the one-sentence
 * reasoning constraint, and the exact JSON output schema (with `circularity`
 * as a strict JSON boolean). The deterministic `validateResult` stage remains
 * the authoritative guard; this prompt only reduces the chance of malformed
 * output.
 */
export const SYSTEM_PROMPT: string = `You are an expert reader of college admissions application essays. Your task is to classify the structural SHAPE of a single student essay and report whether its narrative is circular. Analyze only the essay text provided by the user. Apply the rules below exactly and deterministically.

SHAPE RULES

1. Assign shape = "linear" when the essay is built around unconnected episodes or a chronological timeline, WITHOUT any single recurring object, metaphor, or image that anchors the narrative.

2. Assign shape = "motif" when the essay returns TWO OR MORE times to a single specific object, metaphor, or image that anchors the narrative.

3. If the essay matches BOTH the "linear" and the "motif" rules, assign shape = "motif". The motif rule wins this tie-break.

4. If the essay matches NEITHER the "linear" nor the "motif" rule, assign shape = "linear" as the default.

CIRCULARITY RULES

5. Set circularity = true ONLY when the ending explicitly returns to the EXACT opening image, scene, or question that the essay began with.

6. Otherwise, set circularity = false. Any ending that does not explicitly return to the exact opening image, scene, or question is NOT circular.

REASONING RULE

7. Provide "reasoning" as EXACTLY ONE sentence of NO MORE THAN 200 characters that names the SPECIFIC textual evidence (the concrete object, metaphor, image, scene, or structure in the essay) justifying your "shape" choice.

OUTPUT RULES

Respond with ONLY a single JSON object and nothing else — no markdown, no code fences, no commentary. The JSON object must match this exact schema:

{ "shape": "linear" | "motif", "circularity": <boolean>, "reasoning": "<string>" }

- "shape" MUST be exactly one of the two string literals "linear" or "motif".
- "circularity" MUST be a JSON boolean, either true or false. It must NEVER be a number (such as 0 or 1) and NEVER a string (such as "true" or "false").
- "reasoning" MUST be a non-empty string that is one sentence of at most 200 characters.`;

/**
 * The request payload sent to the LLM seam: the fixed system prompt paired
 * with the student's essay text.
 */
export interface LlmRequest {
  /** Fixed instruction set defining the classification rules. */
  systemPrompt: string;
  /** The raw student essay text to classify. */
  userText: string;
}

/**
 * The internal LLM seam. Isolating the model call behind this narrow function
 * type lets tests substitute a mock so the deterministic parsing/validation
 * logic can be exercised without network calls or model variability.
 *
 * @param req The assembled request payload (system prompt + essay text).
 * @param timeoutMs The maximum time, in milliseconds, to wait for a response.
 * @returns A promise resolving to the raw text returned by the LLM.
 */
export type LlmInvoker = (req: LlmRequest, timeoutMs: number) => Promise<string>;

/**
 * Thrown when the supplied essay text is empty or whitespace-only, before any
 * LLM request is made.
 */
export class EssayRequiredError extends Error {
  constructor(message: string = "Essay_Text is required and must contain at least one non-whitespace character.") {
    super(message);
    this.name = "EssayRequiredError";
  }
}

/**
 * Thrown when the LLM request fails (transport error or rejection) and the
 * classification could not be completed.
 */
export class ClassificationFailedError extends Error {
  constructor(message: string = "The classification could not be completed because the LLM request failed.") {
    super(message);
    this.name = "ClassificationFailedError";
  }
}

/**
 * Thrown when the LLM does not return a response within the 30 second timeout.
 */
export class ClassificationTimeoutError extends Error {
  constructor(
    message: string = `The classification could not be completed: the LLM did not respond within ${LLM_TIMEOUT_MS}ms.`
  ) {
    super(message);
    this.name = "ClassificationTimeoutError";
  }
}

/**
 * Thrown when the LLM response is not well-formed JSON, is missing a required
 * field, or has a wrong-typed or otherwise invalid field.
 */
export class InvalidResponseError extends Error {
  constructor(message: string = "The LLM classification response is invalid.") {
    super(message);
    this.name = "InvalidResponseError";
  }
}

/**
 * Validates that the supplied essay text contains at least one non-whitespace
 * character. Runs before any LLM request so that an empty or whitespace-only
 * essay never incurs a network call.
 *
 * @param essayText The raw student essay text to validate.
 * @throws {EssayRequiredError} When `essayText` is empty or consists solely of
 *   whitespace characters.
 */
function assertNonEmptyEssay(essayText: string): void {
  if (essayText.trim().length === 0) {
    throw new EssayRequiredError();
  }
}

/**
 * Parses the raw text returned by the LLM into a JSON value. This is the
 * parsing stage of the pipeline, kept separate from result validation so that
 * a JSON syntax error produces a distinct, specific error from a schema
 * violation.
 *
 * @param raw The raw text returned by the LLM, expected to contain a JSON
 *   object.
 * @returns The parsed JSON value as `unknown`; the caller narrows it to a
 *   `ClassificationResult` via `validateResult`.
 * @throws {InvalidResponseError} When `raw` is not well-formed JSON. The error
 *   message identifies the underlying JSON syntax fault.
 */
function parseResponse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InvalidResponseError(
      `The LLM classification response is not well-formed JSON: ${detail}`
    );
  }
}
/** The two allowed `shape` literals, used for validation error messages. */
const ALLOWED_SHAPES: readonly ShapeValue[] = ["linear", "motif"];

/** Maximum allowed length, in characters, of the `reasoning` field. */
const MAX_REASONING_LENGTH = 2000;

/**
 * Produces a short, human-readable description of a value's runtime type for
 * use in validation error messages (e.g. "number", "null", "array",
 * "object"). This lets `validateResult` name both the invalid value and its
 * type when a field is wrong-typed.
 *
 * @param value The value to describe.
 * @returns A concise type label.
 */
function describeType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

/**
 * Strictly validates a parsed JSON value and narrows it to a
 * `ClassificationResult`. This is the authoritative guard for the LLM's
 * output: it does not coerce or default any field. Checks run in order so the
 * thrown error always names the first fault encountered:
 *
 * 1. The value is a non-null, non-array object.
 * 2. `shape` is present and exactly `"linear"` or `"motif"`.
 * 3. `circularity` is present and strictly of type `boolean` — a numeric
 *    (`0`/`1`), string (`"true"`/`"false"`), `null`, or object value is
 *    rejected outright; the type is never coerced.
 * 4. `reasoning` is present and is a non-empty string of at most
 *    {@link MAX_REASONING_LENGTH} characters.
 *
 * @param value The parsed JSON value produced by {@link parseResponse}.
 * @returns The value narrowed to a `ClassificationResult`.
 * @throws {InvalidResponseError} When `value` is not an object, or any field
 *   is missing, wrong-typed, or otherwise invalid. The message names the
 *   specific missing field, the invalid `shape` value, the invalid
 *   `circularity` value and its type, or the invalid `reasoning` value.
 */
function validateResult(value: unknown): ClassificationResult {
  // 1. Must be a non-null, non-array object.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidResponseError(
      `The LLM classification response must be a JSON object but was of type ${describeType(value)}.`
    );
  }

  const record = value as Record<string, unknown>;

  // 2. `shape` must exist and be exactly "linear" or "motif".
  if (!("shape" in record)) {
    throw new InvalidResponseError(
      'The LLM classification response is missing the required field "shape".'
    );
  }
  const shape = record.shape;
  if (shape !== "linear" && shape !== "motif") {
    throw new InvalidResponseError(
      `The LLM classification response has an invalid "shape" value: ${JSON.stringify(shape)}. ` +
        `Expected exactly one of ${ALLOWED_SHAPES.map((s) => `"${s}"`).join(" or ")}.`
    );
  }

  // 3. `circularity` must exist and be strictly a boolean (no coercion).
  if (!("circularity" in record)) {
    throw new InvalidResponseError(
      'The LLM classification response is missing the required field "circularity".'
    );
  }
  const circularity = record.circularity;
  if (typeof circularity !== "boolean") {
    throw new InvalidResponseError(
      `The LLM classification response has an invalid "circularity" value: ${JSON.stringify(circularity)} ` +
        `(type ${describeType(circularity)}). It must be a JSON boolean (true or false), ` +
        `never a number, string, null, or object.`
    );
  }

  // 4. `reasoning` must exist and be a non-empty string <= MAX_REASONING_LENGTH chars.
  if (!("reasoning" in record)) {
    throw new InvalidResponseError(
      'The LLM classification response is missing the required field "reasoning".'
    );
  }
  const reasoning = record.reasoning;
  if (typeof reasoning !== "string") {
    throw new InvalidResponseError(
      `The LLM classification response has an invalid "reasoning" value: ${JSON.stringify(reasoning)} ` +
        `(type ${describeType(reasoning)}). It must be a non-empty string.`
    );
  }
  if (reasoning.length === 0) {
    throw new InvalidResponseError(
      'The LLM classification response has an invalid "reasoning" value: it must be a non-empty string.'
    );
  }
  if (reasoning.length > MAX_REASONING_LENGTH) {
    throw new InvalidResponseError(
      `The LLM classification response has an invalid "reasoning" value: its length (${reasoning.length}) ` +
        `exceeds the maximum of ${MAX_REASONING_LENGTH} characters.`
    );
  }

  return { shape, circularity, reasoning };
}

/**
 * Assembles the request payload sent to the LLM seam. Pairs the fixed
 * {@link SYSTEM_PROMPT} (which encodes every classification rule) with the
 * student's essay text. This stage is pure: it performs no I/O and simply
 * shapes the inputs into an {@link LlmRequest}.
 *
 * @param essayText The raw student essay text to classify.
 * @returns An {@link LlmRequest} carrying the system prompt and the essay text.
 */
function buildMessages(essayText: string): LlmRequest {
  return {
    systemPrompt: SYSTEM_PROMPT,
    userText: essayText,
  };
}

/**
 * Injectable dependency boundary for the concrete Kiro LLM call.
 *
 * This project has no confirmed Kiro LLM SDK binding available (there is no
 * package.json / node_modules), so the real model call is isolated behind this
 * single module-level function. The timeout and error-handling wrapper in
 * {@link invokeLlm} delegates here, which keeps that wrapper fully implemented
 * and testable while the concrete SDK binding remains a stub. Tests (and the
 * eventual real integration) override this via {@link setLlmCall}.
 *
 * See design.md — "LLM Seam": the default implementation should use Kiro's LLM
 * capability; this function is exactly where that call belongs.
 *
 * @param req The assembled request payload (system prompt + essay text).
 * @param signal An {@link AbortSignal} that is aborted when the 30 second
 *   timeout elapses; a real SDK binding SHOULD forward it so an in-flight call
 *   is cancelled on timeout.
 * @returns A promise resolving to the raw text returned by the LLM.
 */
let llmCall: (req: LlmRequest, signal: AbortSignal) => Promise<string> = async (
  _req: LlmRequest,
  _signal: AbortSignal
): Promise<string> => {
  // TODO(shape-classifier): Replace this stub with the real Kiro LLM SDK call.
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
 * @param impl The implementation to use for subsequent LLM calls. It receives
 *   the request payload and an {@link AbortSignal} that fires on timeout.
 */
export function setLlmCall(
  impl: (req: LlmRequest, signal: AbortSignal) => Promise<string>
): void {
  llmCall = impl;
}

/**
 * Default LLM seam implementation. Sends the assembled request to the
 * injectable {@link llmCall} boundary and enforces the response timeout in
 * code via `Promise.race` against a timer, aborting the underlying call through
 * an {@link AbortSignal} when the timer wins.
 *
 * Failure mapping (Req 1.3, 1.9):
 * - If the timer wins the race, the promise rejects with
 *   {@link ClassificationTimeoutError}.
 * - If the underlying call rejects for any other reason (transport error or an
 *   SDK rejection), the failure surfaces as {@link ClassificationFailedError}.
 *
 * @param req The assembled request payload (system prompt + essay text).
 * @param timeoutMs The maximum time, in milliseconds, to wait for a response.
 * @returns A promise resolving to the raw text returned by the LLM.
 * @throws {ClassificationTimeoutError} When no response arrives within
 *   `timeoutMs`.
 * @throws {ClassificationFailedError} When the underlying LLM call fails.
 */
const invokeLlm: LlmInvoker = async (
  req: LlmRequest,
  timeoutMs: number
): Promise<string> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ClassificationTimeoutError());
    }, timeoutMs);
  });

  // Surface any underlying-call failure as ClassificationFailedError, while
  // letting a ClassificationTimeoutError from the timer pass through unchanged.
  const call = (async (): Promise<string> => {
    try {
      return await llmCall(req, controller.signal);
    } catch (error) {
      if (error instanceof ClassificationTimeoutError) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new ClassificationFailedError(
        `The classification could not be completed because the LLM request failed: ${detail}`
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
 * Classifies the structural shape of a student essay using Kiro's LLM.
 *
 * Orchestrates the full classification pipeline as a sequence of stages:
 * {@link assertNonEmptyEssay} (reject empty/whitespace input before any LLM
 * call) → {@link buildMessages} (assemble the {@link SYSTEM_PROMPT} with the
 * essay) → `invoker` (send the request under the {@link LLM_TIMEOUT_MS}
 * 30-second timeout) → {@link parseResponse} (parse the raw JSON text) →
 * {@link validateResult} (strictly validate and narrow the parsed value) →
 * return the resulting {@link ClassificationResult}.
 *
 * The LLM seam is injectable via the optional `invoker` parameter, which
 * defaults to the production {@link invokeLlm}. Tests can supply a mock
 * invoker to exercise the deterministic pipeline without a live model, while
 * the default call path always routes through `invokeLlm` with
 * {@link LLM_TIMEOUT_MS}.
 *
 * @param essayText The raw student essay text to classify. Must be non-empty
 *   and contain at least one non-whitespace character.
 * @param invoker The LLM seam to use for the request. Defaults to the
 *   production {@link invokeLlm}; override it in tests to inject a mock.
 * @returns A promise resolving to a {@link ClassificationResult} describing the
 *   essay's `shape` (`"linear"` or `"motif"`), whether the narrative is
 *   circular (`circularity`, a boolean), and a one-sentence `reasoning` string.
 * @throws {EssayRequiredError} When `essayText` is empty or whitespace-only; no
 *   LLM request is made.
 * @throws {ClassificationFailedError} When the LLM request fails (transport
 *   error or rejection).
 * @throws {ClassificationTimeoutError} When the LLM does not respond within
 *   {@link LLM_TIMEOUT_MS}.
 * @throws {InvalidResponseError} When the LLM response is not well-formed JSON,
 *   is missing a required field, or has a wrong-typed or otherwise invalid
 *   field.
 */
export async function classifyShape(
  essayText: string,
  invoker: LlmInvoker = invokeLlm
): Promise<ClassificationResult> {
  assertNonEmptyEssay(essayText);
  const request = buildMessages(essayText);
  const raw = await invoker(request, LLM_TIMEOUT_MS);
  const parsed = parseResponse(raw);
  return validateResult(parsed);
}
