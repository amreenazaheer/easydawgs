/**
 * app.js — the App_Controller for the EasyDawg Frontend.
 *
 * This is the single browser-native ES module entry point that orchestrates the
 * zero-build, vanilla frontend. It reads the reviewer's inputs, injects the demo
 * LLM invoker into the ported modules via `setLlmCall`, runs the evaluation
 * pipeline (`classifyShape` → `evaluateEssay`) in order, and renders the results:
 * the overall band, the six dimension score gauges, the UW feedback cards, and
 * the verbatim span highlights over the essay display.
 *
 * The module is loaded with `<script type="module">` and imports the ported
 * runtime modules (`router.js`, `shape-classifier.js`, `evaluator.js`) and the
 * demo mock (`mock-llm.js`) directly — no bundler, transpiler, or Node runtime.
 *
 * This file is built up across several tasks. The pure, DOM-free helpers are
 * authored first (and exported) so they can be exercised by the browser test
 * harness; the DOM wiring and pipeline orchestration are layered on afterward.
 */

import {
  BASE_VALUES,
  DIMENSION_KEYS,
  MAX_ESSAY_LENGTH,
  evaluateEssay,
  setLlmCall as setEvaluatorLlmCall,
} from "./evaluator.js";
import {
  classifyShape,
  setLlmCall as setClassifierLlmCall,
} from "./shape-classifier.js";
import { liveLlmInvoker } from "./live-llm.js";

/**
 * The essay pre-populated into the editor on load. With the live model wired in,
 * this is just a convenient starting sample the reviewer can replace with any
 * pasted essay — it no longer needs to match any hardcoded mock response.
 *
 * @type {string}
 */
const SAMPLE_ESSAY = `The metronome on my piano ticked like a second heartbeat. I was seven, and its steady arm terrified me because it never slowed down to wait for my clumsy fingers. For years I treated that ticking as an enemy, a judge counting every mistake I made during practice.

In middle school I joined the robotics team, where I learned that rhythm was not a punishment but a tool. We timed our autonomous routines to the half second, and I began to hear the metronome differently, as a partner that kept us honest about what we could actually achieve.

By senior year I was teaching younger students to code, and I caught myself tapping out a steady beat on the desk while they debugged. The metronome had followed me out of the music room and into everything I cared about. Its ticking was no longer a judge but a reminder that steady effort, repeated over time, is how clumsy fingers eventually learn to fly.`;

/**
 * Maps each canonical dimension key to a human-readable label for display on
 * its Score_Gauge (Req 7.4). Keys are the six backend dimensions in canonical
 * order; values are the reviewer-facing labels.
 *
 * @type {{ [key: string]: string }}
 */
export const DimensionLabelMap = {
  focus: "Focus",
  specificity: "Specificity",
  character: "Character",
  how_you_think: "How You Think",
  contribution: "Contribution",
  self_awareness: "Self-Awareness",
};

/**
 * Builds a pure, DOM-free view model for a single Score_Gauge from a dimension
 * key and its corresponding `Evaluation_Result.dimensions[key]` entry.
 *
 * The returned view model carries everything a gauge needs to render: the key,
 * the human-readable label (Req 7.4), the verbatim `score` and `reasoning` from
 * the evaluation result (Req 7.3), the dimension's `baseValue` from the ported
 * `BASE_VALUES` (Req 7.2), and a `fillFraction` of `score / baseValue` used to
 * draw the meter (Req 7.2, 7.5 — full when `score === baseValue`).
 *
 * `fillFraction` is guarded: a `baseValue` of `0` (or any non-finite ratio)
 * never produces `NaN`/`Infinity`, and the fraction is clamped to the inclusive
 * range `[0, 1]` so the meter can never render under-empty or over-full.
 *
 * This helper is pure (no DOM, no mutation of its inputs).
 *
 * @param {string} key - A canonical dimension key (e.g. "how_you_think").
 * @param {{ score: number, span: string, reasoning: string }} dimensionEntry
 *   The `Evaluation_Result.dimensions[key]` entry for that dimension.
 * @returns {{
 *   key: string,
 *   label: string,
 *   score: number,
 *   baseValue: number,
 *   reasoning: string,
 *   fillFraction: number
 * }} The gauge view model.
 */
export function buildGaugeViewModel(key, dimensionEntry) {
  const score = dimensionEntry.score;
  const baseValue = BASE_VALUES[key];

  // Guard against a zero/invalid base value producing NaN or Infinity, then
  // clamp to [0, 1] so the meter stays within its track regardless of input.
  let fillFraction = baseValue > 0 ? score / baseValue : 0;
  if (!Number.isFinite(fillFraction) || fillFraction < 0) {
    fillFraction = 0;
  } else if (fillFraction > 1) {
    fillFraction = 1;
  }

  return {
    key,
    label: DimensionLabelMap[key],
    score,
    baseValue,
    reasoning: dimensionEntry.reasoning,
    fillFraction,
  };
}

/**
 * @typedef {Object} HighlightRange
 * @property {number} start - Inclusive start index into the essay text.
 * @property {number} end - Exclusive end index into the essay text.
 * @property {string[]} dimensions - The canonical dimension keys whose located
 *   span overlapped this merged, non-overlapping interval (in canonical order).
 */

/**
 * @typedef {Object} HighlightComputation
 * @property {HighlightRange[]} ranges - Union-merged, non-overlapping highlight
 *   intervals, sorted ascending by `start`.
 * @property {string[]} notLocated - Canonical dimension keys whose span could
 *   not be located in the essay text (in canonical order).
 */

/**
 * Locates each dimension's verbatim span in the essay text and union-merges the
 * located ranges into sorted, non-overlapping highlight intervals (Req 10.2,
 * 10.3, 10.4, 10.5).
 *
 * For each of the six dimensions (iterated in canonical {@link DIMENSION_KEYS}
 * order), the span is read from `dimensions[key].span` and located by its FIRST
 * occurrence via `essayText.indexOf(span)` counting from index 0 — an exact,
 * case-sensitive match (Req 10.2, 10.3). A span found at index `i` yields the
 * half-open range `[i, i + span.length)`. When `indexOf` returns `-1`, or the
 * span is missing / empty / not a string, the span is NOT located: no range is
 * produced and the dimension key is recorded in `notLocated` (Req 10.5). No
 * highlight is ever fabricated for an unlocated span.
 *
 * The located ranges are then union-merged (Req 10.4): sorted by `start`, then
 * folded so overlapping OR touching ranges (where one range's `end` meets the
 * next range's `start`) collapse into a single contiguous interval. A character
 * is covered iff at least one span covers it; overlaps carry no special
 * styling — each merged {@link HighlightRange} simply accumulates every
 * contributing dimension key whose located span overlapped that interval
 * (comparing the span's half-open extent against the merged interval, `end`
 * exclusive). Contributing keys are emitted in canonical order.
 *
 * This helper is pure: it reads only its inputs, performs no DOM work, and does
 * not mutate `essayText` or `dimensions`.
 *
 * @param {string} essayText - The current essay text to locate spans within.
 * @param {{ [key: string]: { span?: unknown } }} dimensions - The
 *   `Evaluation_Result.dimensions` six-key object; each entry's `span` is the
 *   verbatim substring to locate.
 * @returns {HighlightComputation} The union-merged `ranges` (sorted ascending,
 *   non-overlapping) and the `notLocated` dimension keys.
 */
export function computeHighlightRanges(essayText, dimensions) {
  const text = typeof essayText === "string" ? essayText : "";

  /** @type {{ start: number, end: number, key: string }[]} */
  const located = [];
  /** @type {string[]} */
  const notLocated = [];

  // 1. Locate each dimension's span by its first occurrence, in canonical order.
  for (const key of DIMENSION_KEYS) {
    const entry = dimensions ? dimensions[key] : undefined;
    const span = entry ? entry.span : undefined;

    // An empty or non-string span can never be located; flag and skip it.
    if (typeof span !== "string" || span.length === 0) {
      notLocated.push(key);
      continue;
    }

    const index = text.indexOf(span);
    if (index === -1) {
      notLocated.push(key);
      continue;
    }

    located.push({ start: index, end: index + span.length, key });
  }

  // 2. Union-merge the located ranges into sorted, non-overlapping intervals.
  //    Sort by start (then by end) so a single forward fold can merge any
  //    overlapping or touching ranges.
  const sorted = located
    .slice()
    .sort((a, b) => (a.start - b.start) || (a.end - b.end));

  /** @type {{ start: number, end: number, keys: Set<string> }[]} */
  const merged = [];
  for (const range of sorted) {
    const current = merged[merged.length - 1];
    // Merge when this range overlaps or touches the current merged interval.
    // With half-open intervals, `range.start <= current.end` covers both the
    // overlapping case (start < end) and the touching case (start === end).
    if (current !== undefined && range.start <= current.end) {
      current.end = Math.max(current.end, range.end);
      current.keys.add(range.key);
    } else {
      merged.push({ start: range.start, end: range.end, keys: new Set([range.key]) });
    }
  }

  // 3. Shape each merged interval into a HighlightRange whose `dimensions` lists
  //    every contributing key in canonical order. (A touching merge can join two
  //    spans that do not themselves overlap the full interval; recompute each
  //    interval's contributors by testing every located span against it so the
  //    keys reflect actual coverage, `end` exclusive.)
  const ranges = merged.map((interval) => {
    const contributors = DIMENSION_KEYS.filter((key) =>
      located.some(
        (range) =>
          range.key === key &&
          range.start < interval.end &&
          range.end > interval.start
      )
    );
    return { start: interval.start, end: interval.end, dimensions: contributors };
  });

  return { ranges, notLocated };
}

/**
 * @typedef {Object} BackdropSegment
 * @property {string} text - The RAW essay substring for this run. It is NOT
 *   HTML-escaped here so that concatenating every segment's `text` reproduces
 *   the original essay text exactly (Property 10 — character preservation).
 *   The renderer (task 8.3) escapes at DOM-build time via `textContent` (or the
 *   exported {@link escapeHtml} helper), which preserves whitespace and avoids
 *   double-escaping.
 * @property {boolean} highlighted - `true` for a covered run (rendered as a
 *   `<mark class="hl">`), `false` for a plain uncovered run.
 * @property {string[]} dimensions - For a highlighted run, the contributing
 *   dimension keys for this covered interval (canonical order, from the merged
 *   {@link HighlightRange}); always an empty array for a plain run.
 */

/**
 * Builds the ordered backdrop segment list the renderer uses to paint the essay
 * display: alternating plain-text runs and highlighted runs that together cover
 * the entire essay text exactly once, with no gaps and no overlaps (Req 10.2,
 * 10.7, 13.2, 13.3).
 *
 * The walk advances a cursor from index 0 through `essayText`. The
 * `highlightRanges` array is the `ranges` field from
 * {@link computeHighlightRanges} — already sorted ascending by `start` and
 * guaranteed non-overlapping. For each range the function:
 *   1. emits a plain-text segment for the uncovered run between the cursor and
 *      the range's `start` (only when that run is non-empty), then
 *   2. emits a highlighted segment for the covered run `[start, end)`, carrying
 *      the range's contributing dimension keys.
 * After the last range, any remaining uncovered tail is emitted as a final
 * plain-text segment.
 *
 * Because `text` holds the raw substring (`essayText.slice(...)`), concatenating
 * every returned segment's `text` equals `essayText` exactly, preserving all
 * characters, whitespace, and line breaks (Property 10; the backdrop renders
 * with `white-space: pre-wrap`). Escaping is deferred to the renderer — this
 * function performs no HTML-escaping and no DOM work.
 *
 * Edge cases:
 *   - Empty `essayText` → empty segment list (`[]`).
 *   - No ranges → a single plain-text segment spanning the whole essay.
 *   - Ranges covering the whole essay → a single highlighted segment.
 *
 * This helper is pure: it reads only its inputs and never mutates them.
 *
 * @param {string} essayText - The current essay text to segment.
 * @param {HighlightRange[]} highlightRanges - The sorted, non-overlapping
 *   `ranges` from {@link computeHighlightRanges}.
 * @returns {BackdropSegment[]} The ordered backdrop segments covering the essay
 *   text exactly once.
 */
export function buildBackdropSegments(essayText, highlightRanges) {
  const text = typeof essayText === "string" ? essayText : "";

  /** @type {BackdropSegment[]} */
  const segments = [];

  // Empty essay → no segments to render.
  if (text.length === 0) {
    return segments;
  }

  const ranges = Array.isArray(highlightRanges) ? highlightRanges : [];

  let cursor = 0;
  for (const range of ranges) {
    // Defensive clamping: keep indices within the essay and ignore any range
    // that cannot contribute a covered run (end <= start after clamping) or
    // that falls entirely behind the cursor. The ranges are expected to be
    // sorted and non-overlapping, so this preserves a strictly forward walk.
    const start = Math.max(cursor, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));

    // Plain-text run before this highlight (emit only when non-empty).
    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), highlighted: false, dimensions: [] });
    }

    // Highlighted run for the covered interval (emit only when non-empty).
    if (end > start) {
      const dimensions = Array.isArray(range.dimensions) ? range.dimensions.slice() : [];
      segments.push({ text: text.slice(start, end), highlighted: true, dimensions });
      cursor = end;
    }
  }

  // Trailing uncovered run after the last highlight.
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), highlighted: false, dimensions: [] });
  }

  return segments;
}

/**
 * Escapes the five HTML-significant characters (`&`, `<`, `>`, `"`, `'`) in a
 * string to their named/numeric entities, for the renderer (task 8.3) to use
 * when it must build markup from essay-derived text.
 *
 * Note: {@link buildBackdropSegments} intentionally does NOT call this — segment
 * `text` is kept raw so Property 10 holds. The preferred render path sets
 * `textContent`, which escapes implicitly; this helper is provided for any code
 * path that assembles an HTML string directly. `&` is replaced first so that
 * entities produced for the other characters are not themselves re-escaped.
 *
 * @param {string} str - The raw string to escape.
 * @returns {string} The HTML-escaped string.
 */
export function escapeHtml(str) {
  const s = typeof str === "string" ? str : String(str);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ===========================================================================
 * Task 7.1 — Seam injection and the input gate
 *
 * These two pieces run BEFORE any evaluation pipeline stage. The seam injection
 * replaces the throwing default `setLlmCall` stub in BOTH ported modules with
 * the demo mock invoker so no stage ever executes against the not-configured
 * stub (Req 11.1). The input gate rejects empty/whitespace-only and over-length
 * essays before any LLM call is made (Req 5.3, 5.4, 6.2).
 * ======================================================================== */

/**
 * Tracks whether the live LLM invoker has been injected into the ported
 * modules. Starts `false` (the modules boot with their throwing default stub)
 * and flips to `true` the first time {@link installLiveLlm} runs. Read via
 * {@link isLiveMode} by the status banner.
 *
 * @type {boolean}
 */
let liveMode = false;

/**
 * Injects the live LLM invoker into BOTH ported pipeline modules via their
 * `setLlmCall` seams, so neither `classifyShape` (`shape-classifier.js`) nor
 * `evaluateEssay` (`evaluator.js`) ever runs against the throwing default stub.
 * The single {@link liveLlmInvoker} serves both modules — each calls it with its
 * own system prompt, and the invoker forwards that prompt to the live model and
 * returns the model's raw text for the module to parse and validate.
 *
 * Calling this more than once is safe and idempotent: it simply re-installs the
 * same invoker and leaves {@link liveMode} `true`.
 *
 * @returns {void}
 */
export function installLiveLlm() {
  setClassifierLlmCall(liveLlmInvoker);
  setEvaluatorLlmCall(liveLlmInvoker);
  liveMode = true;
}

/**
 * Reports whether the live LLM invoker is the active invoker, i.e. whether
 * {@link installLiveLlm} has run. The status banner reads this to decide whether
 * to show the persistent "connected to a live model" banner.
 *
 * @returns {boolean} `true` once the live invoker has been installed.
 */
export function isLiveMode() {
  return liveMode;
}

/**
 * @typedef {Object} EssayGateDecision
 * @property {boolean} valid - `true` when the essay text is within the accepted
 *   input range (non-empty after trimming and at most {@link MAX_ESSAY_LENGTH}
 *   characters), `false` otherwise.
 * @property {"empty" | "too_long"} [reason] - Present only when `valid` is
 *   `false`; identifies why the essay was rejected.
 * @property {string} [message] - Present only when `valid` is `false`; the
 *   reviewer-facing message describing the rejection.
 */

/**
 * The input gate: a pure, DOM-free decision on whether an essay may proceed to
 * the evaluation pipeline, run BEFORE any LLM call (Req 5.3, 5.4, 6.2).
 *
 * Three outcomes:
 *   - Empty / whitespace-only (`text` is not a string, is empty, or trims to
 *     zero length) → rejected with `reason: "empty"` and the invalid-essay
 *     message (Req 5.3). No `classifyShape` or `evaluateEssay` call follows.
 *   - Over-length (`text.length` strictly greater than {@link MAX_ESSAY_LENGTH})
 *     → rejected with `reason: "too_long"` and a message naming the
 *     20000-character maximum and the actual length (Req 5.4). No
 *     `evaluateEssay` call follows.
 *   - Otherwise → `{ valid: true }`.
 *
 * Length is measured against the RAW `text.length` (matching the ported
 * `evaluator.js` `assertNonEmptyEssay`, which bounds the un-trimmed length);
 * emptiness is measured against the trimmed text so a whitespace-only essay is
 * rejected as empty rather than evaluated.
 *
 * This helper is pure: it reads only its argument, touches no DOM, and never
 * invokes the pipeline.
 *
 * @param {string} text - The current Essay_Input text.
 * @returns {EssayGateDecision} The gate decision.
 */
export function validateEssayInput(text) {
  // Reject anything that is not usable text: a non-string, the empty string, or
  // a value that contains only whitespace. These never reach the LLM (Req 5.3).
  if (typeof text !== "string" || text.trim().length === 0) {
    return {
      valid: false,
      reason: "empty",
      message: "Please paste an essay before evaluating.",
    };
  }

  // Reject an essay longer than the accepted maximum before any evaluateEssay
  // call. Measured against the raw length to mirror evaluator.js (Req 5.4).
  if (text.length > MAX_ESSAY_LENGTH) {
    return {
      valid: false,
      reason: "too_long",
      message:
        `This essay is ${text.length} characters, which exceeds the ` +
        `${MAX_ESSAY_LENGTH}-character maximum. Please shorten it before evaluating.`,
    };
  }

  return { valid: true };
}

/* ===========================================================================
 * Task 7.2 — The pipeline orchestrator
 *
 * runPipeline is the DOM-free core of the Evaluate action: it runs the two
 * ported pipeline stages in the strict order the design mandates
 * (classifyShape -> evaluateEssay) and returns both module-produced results to
 * the render layer untouched. The input gate (validateEssayInput, task 7.1) has
 * already accepted the text, and the mock invoker (installMockLlm, task 7.1) has
 * already been injected into both modules by the caller (the state machine, task
 * 7.3). This function performs NO DOM work and catches NO errors: every pipeline
 * error class propagates to the caller, which maps it to a UI state (task 7.3).
 * ======================================================================== */

/**
 * @typedef {Object} ClassificationResult
 * @property {"linear" | "motif"} shape - The classified structural shape.
 * @property {boolean} circularity - Whether the narrative is circular.
 * @property {string} reasoning - One-sentence justification (≤ 2000 chars).
 */

/**
 * @typedef {Object} PipelineResult
 * @property {ClassificationResult} classification - The verbatim
 *   `Classification_Result` returned by `classifyShape`.
 * @property {Object} evaluation - The verbatim `Evaluation_Result` returned by
 *   `evaluateEssay` (band, dimensions, mechanics, revisions, claims).
 */

/**
 * Orchestrates the evaluation pipeline for an essay that has already passed the
 * input gate ({@link validateEssayInput}), running the two ported stages in the
 * strict design order and returning both module results to the render layer
 * (Req 6.1, 6.3, 6.5, 6.6, 6.7, 2.1).
 *
 * Preconditions (owned by the caller — the state machine in task 7.3):
 *   - `essayText` has already been accepted by {@link validateEssayInput}.
 *   - {@link installMockLlm} has already run, so both ported modules have the
 *     demo mock invoker injected and neither hits the throwing default stub.
 *
 * Stages, in order:
 *   1. `classification = await classifyShape(essayText)` — the ported classifier
 *      produces `{ shape, circularity, reasoning }` (Req 6.1).
 *   2. `modifiers = {}` — this iteration collects no `StudentProfile` and never
 *      calls `evaluateProfile`; an empty modifiers record flows straight into
 *      the evaluator (Req 6.4, confirmed design decision).
 *   3. `evaluation = await evaluateEssay(essayText, modifiers, classification.shape)`
 *      — the ported evaluator produces the `Evaluation_Result` with its own
 *      computed band and deterministic scoring (Req 6.5).
 *
 * Because step 1 is `await`ed before step 3, a rejection from `classifyShape`
 * (e.g. `ClassificationTimeoutError`, `ClassificationFailedError`,
 * `InvalidResponseError`, `EssayRequiredError`) aborts the function before
 * `evaluateEssay` is ever called (Req 6.6, 6.7). This orchestrator does NOT
 * catch any error: every pipeline error class propagates to the caller, which
 * maps it to a UI state and renders no partial result (task 7.3, Req 12).
 *
 * The returned object carries the module results verbatim — the frontend never
 * substitutes a self-computed value for a module-returned one (Req 2.1, 8.2).
 *
 * This function performs no DOM work; it only orchestrates the ported modules.
 *
 * @param {string} essayText - The essay text, already accepted by the gate.
 * @returns {Promise<PipelineResult>} The `classification` and `evaluation`
 *   results for the render layer.
 */
export async function runPipeline(essayText) {
  // Step 1: classify the essay's structural shape. Awaited first so that a
  // classifier rejection aborts the pipeline before the evaluator runs.
  const classification = await classifyShape(essayText);

  // Step 2: no StudentProfile is collected this iteration, so evaluateProfile is
  // never called and an empty modifiers record flows into the evaluator.
  const modifiers = {};

  // Step 3: evaluate the essay using the classified shape and empty modifiers.
  const evaluation = await evaluateEssay(essayText, modifiers, classification.shape);

  // Return the module results verbatim for the render layer.
  return { classification, evaluation };
}
/* ===========================================================================
 * Task 7.3 — The UI state machine and error-class mapping
 *
 * This layer drives the Evaluate action end-to-end: idle → running →
 * (success | error). It wires the pure helpers (validateEssayInput, task 7.1;
 * runPipeline, task 7.2) to the DOM and maps every thrown pipeline error class
 * to a distinct, reviewer-facing UI message (Req 12.2–12.5), never rendering a
 * fabricated or partial result on failure (Req 2.4, 6.7, 6.8, 11.3).
 *
 * To keep this logic testable without hard-coupling to a DOM, the DOM is
 * touched only through guarded, lazy `document.getElementById` lookups using the
 * IDs that task 10.1 will create. Every DOM access checks for the element first,
 * so the pure, exported functions (notably `mapErrorToUiMessage`) remain usable
 * in the browser/standalone test harness even when no document exists. The
 * render entry points `renderResults` / `clearResults` (task 8.x) are called
 * only when present via `typeof` guards, so referencing them here never throws a
 * ReferenceError before task 8.x defines them.
 *
 * Element IDs (shared with task 10.1 HTML and task 11.1 CSS):
 *   - essay input textarea:   id="essay-input"
 *   - Evaluate button:        id="evaluate-btn"
 *   - status/error area:      id="status-area"
 *   - in-progress indicator:  id="loading-indicator" (and a "running" class
 *                             toggled on the status area as a fallback cue)
 * ======================================================================== */

/**
 * The canonical kinds a UI status message can carry, derived from the thrown
 * pipeline error's `.name`. Used to tag the status area (e.g. for styling) and
 * to let the harness assert which branch fired without string-matching the
 * human-readable copy.
 *
 * @typedef {(
 *   "invalid_essay" |
 *   "timeout" |
 *   "failed" |
 *   "invalid_response" |
 *   "modules_not_loaded" |
 *   "llm_not_configured" |
 *   "unknown"
 * )} UiMessageKind
 */

/**
 * @typedef {Object} UiMessage
 * @property {UiMessageKind} kind - The classified message kind.
 * @property {string} message - The reviewer-facing message text.
 */

/**
 * Pure mapping from a thrown pipeline error to the `{ kind, message }` the UI
 * surfaces, branching on `error && error.name` so a `null`/`undefined` error (or
 * one without a `.name`) falls through to the generic fallback rather than
 * throwing (Req 2.4, 6.7, 6.8, 11.3, 12.2, 12.3, 12.4, 12.5).
 *
 * The branches mirror the design's Error Handling table one-to-one:
 *   - `EssayRequiredError` → invalid-essay message (Req 12.5).
 *   - `ClassificationTimeoutError` / `EvaluationTimeoutError` → 30-second
 *     timeout message (Req 12.2).
 *   - `ClassificationFailedError` / `EvaluationFailedError` → evaluation-failed
 *     message (Req 12.3).
 *   - `InvalidResponseError` → invalid-response message; no partial scores
 *     (Req 11.3, 12.4).
 *   - anything else → a generic "something went wrong" fallback.
 *
 * Because each ported module defines its own error classes, this function keys
 * on the `.name` string (identical across both modules for the shared class
 * names) rather than a single shared class or `instanceof`, which lets one
 * mapping serve classifier and evaluator errors alike.
 *
 * This helper is pure: it reads only its argument, touches no DOM, and never
 * throws.
 *
 * @param {unknown} error - The thrown pipeline error (any value).
 * @returns {UiMessage} The classified kind and reviewer-facing message.
 */
export function mapErrorToUiMessage(error) {
  const name = error && error.name;

  switch (name) {
    case "EssayRequiredError":
      return {
        kind: "invalid_essay",
        message: "Please paste an essay before evaluating.",
      };

    case "ClassificationTimeoutError":
    case "EvaluationTimeoutError":
      return {
        kind: "timeout",
        message:
          "The model did not respond within 30 seconds. Please try again.",
      };

    case "ClassificationFailedError":
    case "EvaluationFailedError":
      return {
        kind: "failed",
        message:
          "The evaluation could not be completed. Please try again.",
      };

    case "InvalidResponseError":
      return {
        kind: "invalid_response",
        message:
          "The model returned an invalid response. Please try again.",
      };

    default:
      return {
        kind: "unknown",
        message:
          "Something went wrong during evaluation. Please try again.",
      };
  }
}

/**
 * Guarded, lazy lookup of a DOM element by id. Returns `null` when there is no
 * `document` (the test harness / standalone context) or no matching element, so
 * every caller can no-op safely without a `document is not defined` or null
 * dereference. Centralizing the guard keeps the state-machine code free of
 * repeated existence checks.
 *
 * @param {string} id - The element id to resolve.
 * @returns {HTMLElement | null} The element, or `null` when unavailable.
 */
function getEl(id) {
  if (typeof document === "undefined" || !document.getElementById) {
    return null;
  }
  return document.getElementById(id);
}

/**
 * Writes a status/error message into the status area (`id="status-area"`),
 * tagging it with its {@link UiMessageKind} via a `data-kind` attribute so CSS
 * (task 11.1) and the test harness can distinguish message kinds without parsing
 * the copy. Fully guarded: when the status area is absent (no DOM), this is a
 * no-op, keeping the surrounding logic usable headlessly.
 *
 * @param {string} message - The reviewer-facing message text.
 * @param {UiMessageKind} [kind] - The classified kind used to tag the area.
 * @returns {void}
 */
export function setStatusMessage(message, kind) {
  const statusArea = getEl("status-area");
  if (statusArea === null) {
    return;
  }

  statusArea.textContent = typeof message === "string" ? message : "";
  if (typeof kind === "string" && kind.length > 0) {
    statusArea.setAttribute("data-kind", kind);
  } else {
    statusArea.removeAttribute("data-kind");
  }
}

/**
 * Reflects the running/idle UI state into the DOM (Req 12.1, 12.6): while
 * running, the in-progress indicator (`id="loading-indicator"`) is shown, the
 * status area carries a `running` class as a fallback cue, and the Evaluate
 * button (`id="evaluate-btn"`) is disabled; on settle, the indicator is hidden,
 * the class removed, and the button re-enabled. Every DOM touch is guarded so
 * the function is a safe no-op without a document.
 *
 * The indicator is toggled via the `hidden` attribute (rather than inline
 * styles) so task 11.1's CSS owns its appearance; when the dedicated indicator
 * element is absent, the `running` class on the status area still conveys the
 * state.
 *
 * @param {boolean} isRunning - `true` to enter the running state, `false` to
 *   settle back to idle.
 * @returns {void}
 */
export function setRunning(isRunning) {
  const running = Boolean(isRunning);

  const loadingIndicator = getEl("loading-indicator");
  if (loadingIndicator !== null) {
    loadingIndicator.hidden = !running;
  }

  const statusArea = getEl("status-area");
  if (statusArea !== null && statusArea.classList) {
    statusArea.classList.toggle("running", running);
  }

  const evaluateBtn = getEl("evaluate-btn");
  if (evaluateBtn !== null) {
    evaluateBtn.disabled = running;
  }
}

/**
 * Clears any previously rendered results (band, gauges, cards, highlights,
 * span-not-located indications) by delegating to the task-8.x `clearResults`
 * entry point when it exists. Guarded with a `typeof` check so a reference here
 * never throws before task 8.x defines `clearResults`. Used on the failure path
 * so no stale or partial result survives an error (Req 6.7, 6.8, 11.3).
 *
 * @returns {void}
 */
function clearRenderedResults() {
  // `clearResults` is defined by task 8.x in this same module. Call it only when
  // it is already a function so this layer stands alone before 8.x lands.
  if (typeof clearResults === "function") {
    // eslint-disable-next-line no-undef
    clearResults();
  }
}

/**
 * The Evaluate action's state-machine driver: idle → running → (success |
 * error). It reads the current essay text, runs the input gate, and — only on
 * valid input — injects the mock, enters the running state, awaits the pipeline,
 * and on settle renders results or an error message and returns to idle
 * (Req 5.3, 5.4, 6.2, 6.7, 6.8, 11.2, 11.3, 12.1–12.6, 2.3, 2.4).
 *
 * Flow:
 *   1. Read `essay-input`'s current value (empty string when the element is
 *      absent, so the gate below cleanly rejects in a headless context).
 *   2. **Input gate** ({@link validateEssayInput}): if invalid, show the gate
 *      message in the status area and return WITHOUT calling the pipeline — no
 *      `classifyShape`/`evaluateEssay` runs for invalid input (Req 5.3, 5.4,
 *      6.2).
 *   3. **Modules-loaded guard**: if the ported `classifyShape`/`evaluateEssay`
 *      imports are unavailable, show the "modules not loaded" message and return
 *      without entering the running state (Req 2.3).
 *   4. **Valid path**: `installMockLlm()` (idempotent), transition to running
 *      (show indicator + disable the button, Req 12.1), then
 *      `await runPipeline(text)`.
 *   5. **Success**: call the task-8.x `renderResults(classification, evaluation,
 *      essayText)` entry point when present and show a success status;
 *      transition to success.
 *   6. **Failure**: catch the error, clear any prior rendered results so nothing
 *      partial survives (Req 6.7, 6.8, 11.3), then map the error to a message.
 *      A not-configured LLM (error message includes "not configured") surfaces
 *      the dedicated "LLM not configured" message (Req 11.2); otherwise
 *      {@link mapErrorToUiMessage} classifies it (Req 12.2–12.5).
 *   7. **Finally**: always leave the running state — hide the indicator and
 *      re-enable the button (Req 12.6).
 *
 * The render entry points are called only through `typeof` guards, so this
 * driver is complete and runnable before task 8.x defines `renderResults` /
 * `clearResults`.
 *
 * @returns {Promise<void>} Resolves once the action has settled back to idle.
 */
export async function handleEvaluateClick() {
  // 1. Read the current essay text. A missing element yields "" so the gate
  //    below rejects it as empty rather than throwing.
  const essayInput = getEl("essay-input");
  const essayText = essayInput !== null ? essayInput.value : "";

  // 2. Input gate — reject empty/whitespace-only and over-length BEFORE any LLM
  //    call. On rejection, show the gate message and stop (Req 5.3, 5.4, 6.2).
  const gate = validateEssayInput(essayText);
  if (!gate.valid) {
    // Both the empty/whitespace and over-length rejections surface under the
    // invalid-essay kind (the design's EssayRequiredError row, Req 12.5); the
    // gate's own `message` distinguishes the two to the reviewer.
    setStatusMessage(gate.message, "invalid_essay");
    // Nothing ran, so no results to clear beyond any prior render; drop stale
    // output so a rejected re-evaluation cannot leave old scores on screen.
    clearRenderedResults();
    return;
  }

  // 3. Modules-loaded guard — if the ported pipeline functions did not import,
  //    show the not-loaded message and render nothing (Req 2.3).
  if (typeof classifyShape !== "function" || typeof evaluateEssay !== "function") {
    setStatusMessage(
      "The evaluation modules are not loaded. Please reload the page.",
      "modules_not_loaded"
    );
    clearRenderedResults();
    return;
  }

  // 4. Valid path — inject the live LLM invoker (idempotent) so no stage hits
  //    the throwing default stub, then enter the running state (Req 12.1).
  installLiveLlm();
  setStatusMessage("Evaluating the essay…", "running");
  setRunning(true);

  try {
    const { classification, evaluation } = await runPipeline(essayText);

    // 5. Success — hand the verbatim module results to the render layer (task
    //    8.x) and report success. Guarded so this works before 8.x lands.
    if (typeof renderResults === "function") {
      // eslint-disable-next-line no-undef
      renderResults(classification, evaluation, essayText);
    }
    setStatusMessage("Evaluation complete.", "success");
  } catch (error) {
    // 6. Failure — never render a partial/fabricated result: clear any prior
    //    band/gauges/cards/highlights first (Req 6.7, 6.8, 11.3).
    clearRenderedResults();

    // A not-configured LLM (the throwing default stub, surfaced as a *Failed
    // error whose message mentions "not configured") gets its own message
    // (Req 11.2). Live-LLM transport failures (CORS, network, non-2xx HTTP,
    // auth) carry a detailed, actionable message from live-llm.js that the
    // pipeline nests inside its *FailedError — surface that detail verbatim
    // instead of the generic "could not be completed" so the cause is visible.
    // All other errors are classified by name (Req 12.2–12.5).
    const message = error && typeof error.message === "string" ? error.message : "";
    const name = error && typeof error.name === "string" ? error.name : "";
    if (message.includes("not configured")) {
      setStatusMessage(
        "The LLM is not configured. Paste your API key into live-llm.js (API_KEY).",
        "llm_not_configured"
      );
    } else if (
      name === "EvaluationFailedError" ||
      name === "ClassificationFailedError"
    ) {
      // A *FailedError means the invoker itself threw (transport/CORS/HTTP/auth
      // failure, or a non-JSON model response). The pipeline nests the invoker's
      // actionable message inside its own after the text "request failed:".
      // Surface that nested detail verbatim instead of the generic "could not be
      // completed" so the real cause is visible on screen (and in the console).
      const detail = message.replace(/^.*?request failed:\s*/, "").trim();
      setStatusMessage(
        detail.length > 0 ? detail : mapErrorToUiMessage(error).message,
        "failed"
      );
    } else {
      const mapped = mapErrorToUiMessage(error);
      setStatusMessage(mapped.message, mapped.kind);
    }
  } finally {
    // 7. Settle — always leave the running state: hide the indicator and
    //    re-enable the Evaluate action (Req 12.6).
    setRunning(false);
  }
}
/* ===========================================================================
 * Task 8.1 — Render the band and the six score gauges
 *
 * This is the first slice of the DOM render layer. It defines the two render
 * entry points that the task-7.3 state machine already calls through `typeof`
 * guards:
 *
 *   - `renderResults(classification, evaluation, essayText)` — the success-path
 *     entry point. In THIS task it renders the overall band (exactly as
 *     returned, Req 8.1, 8.2) and the six score gauges in canonical order
 *     (Req 2.1, 7.1–7.5, 10.5, 13.1). It leaves extension points for the later
 *     slices — the feedback cards (task 8.2), the highlight overlay (task 8.3),
 *     and the demo indicator (task 8.4) — invoked only through `typeof` guards
 *     so this file stands alone until those tasks define them.
 *   - `clearResults()` — wipes the band, gauges, feedback cards, and highlight
 *     indications so a failed evaluation never leaves a stale or partial result
 *     on screen (Req 6.7, 6.8, 11.3).
 *
 * Both are HOISTED function declarations so the task-7.3 `typeof renderResults`
 * / `typeof clearResults` guards resolve them regardless of source order.
 *
 * All text is written via `textContent` — never `innerHTML` of essay-derived or
 * model-derived strings — so no span, reasoning, or essay text can inject
 * markup (Req 10.2, 10.7 safety, consistent with the backdrop strategy).
 *
 * Element IDs (shared with task 10.1 HTML and task 11.1 CSS):
 *   - band display:       id="band-display"
 *   - gauges container:   id="gauges"
 *   - feedback cards:     id="feedback-cards"   (populated by task 8.2)
 *   - highlight backdrop: id="essay-backdrop"   (populated by task 8.3)
 * ======================================================================== */

/**
 * Renders the overall band value into the band display (`id="band-display"`),
 * exactly as returned in `Evaluation_Result.band` with no recomputation in the
 * frontend (Req 8.1, 8.2).
 *
 * The band is emitted as the literal text `Band {n}` (e.g. `Band 4`) via
 * `textContent`. The value is taken verbatim from the module-produced
 * `evaluation.band`; the frontend never derives or clamps it. The element's
 * `data-band` attribute mirrors the raw value so CSS/the test harness can read
 * the band without parsing the copy. Fully guarded: when the band element is
 * absent (headless/test context, or before task 10.1 adds the markup), this is
 * a safe no-op.
 *
 * @param {{ band: number }} evaluation - The verbatim `Evaluation_Result`.
 * @returns {void}
 */
function renderBand(evaluation) {
  const bandEl = getEl("band-display");
  if (bandEl === null) {
    return;
  }

  const band = evaluation ? evaluation.band : undefined;
  // Render exactly what the module returned — no recomputation (Req 8.2).
  bandEl.textContent = `Band ${band}`;
  bandEl.setAttribute("data-band", String(band));
}

/**
 * Builds the DOM node for a single Score_Gauge from a gauge view model
 * (produced by {@link buildGaugeViewModel}). The gauge carries, all via
 * `textContent` so no model-derived string can inject markup:
 *
 *   - a human-readable label (Req 7.4),
 *   - an accessible meter (`role="meter"`) exposing the dimension name, score,
 *     and base value through `aria-valuenow` / `aria-valuemin="0"` /
 *     `aria-valuemax="{baseValue}"` / `aria-label="{label}: {score} of
 *     {baseValue}"` (Req 13.1),
 *   - a visual bar inside the meter whose width is `fillFraction * 100%` — full
 *     when `score === baseValue` (Req 7.2, 7.5),
 *   - the numeric score shown as `{score} / {baseValue}` (Req 7.3),
 *   - the dimension's `reasoning` text (Req 7.3),
 *   - an empty, hidden "span not located" slot keyed to the dimension
 *     (`data-dimension` + `id="span-missing-{key}"`) that task 8.3 reveals and
 *     fills when that dimension's span cannot be located (Req 10.5).
 *
 * The node is tagged `data-dimension={key}` so task 8.3 can find the right gauge
 * to flag. This helper builds detached DOM only; the caller appends it.
 *
 * @param {{
 *   key: string,
 *   label: string,
 *   score: number,
 *   baseValue: number,
 *   reasoning: string,
 *   fillFraction: number
 * }} vm - The gauge view model.
 * @returns {HTMLElement} The detached gauge element.
 */
function buildGaugeElement(vm) {
  const gauge = document.createElement("div");
  gauge.className = "gauge";
  gauge.setAttribute("data-dimension", vm.key);

  // Label — human-readable dimension name (Req 7.4).
  const label = document.createElement("div");
  label.className = "gauge-label";
  label.textContent = vm.label;
  gauge.appendChild(label);

  // Accessible meter + visual bar (Req 7.2, 7.5, 13.1). role="meter" plus the
  // aria-* attributes make the dimension name, score, and base value a
  // programmatically determinable text alternative.
  const meter = document.createElement("div");
  meter.className = "gauge-meter";
  meter.setAttribute("role", "meter");
  meter.setAttribute("aria-valuenow", String(vm.score));
  meter.setAttribute("aria-valuemin", "0");
  meter.setAttribute("aria-valuemax", String(vm.baseValue));
  meter.setAttribute("aria-label", `${vm.label}: ${vm.score} of ${vm.baseValue}`);

  const bar = document.createElement("div");
  bar.className = "gauge-bar";
  // Width is fillFraction*100% — full (100%) exactly when score === baseValue
  // because buildGaugeViewModel returns fillFraction === 1 in that case.
  bar.style.width = `${vm.fillFraction * 100}%`;
  meter.appendChild(bar);
  gauge.appendChild(meter);

  // Numeric score, shown as "{score} / {baseValue}" (Req 7.3).
  const scoreEl = document.createElement("div");
  scoreEl.className = "gauge-score";
  scoreEl.textContent = `${vm.score} / ${vm.baseValue}`;
  gauge.appendChild(scoreEl);

  // Reasoning text, verbatim from the evaluation result (Req 7.3).
  const reasoningEl = document.createElement("div");
  reasoningEl.className = "gauge-reasoning";
  reasoningEl.textContent = vm.reasoning;
  gauge.appendChild(reasoningEl);

  // Per-gauge "span not located" slot — empty and hidden here; task 8.3 reveals
  // and populates it from the highlight computation when this dimension's span
  // cannot be located in the essay (Req 10.5). The stable id + data-dimension
  // give that task a reliable hook.
  const spanMissing = document.createElement("span");
  spanMissing.className = "span-missing";
  spanMissing.id = `span-missing-${vm.key}`;
  spanMissing.setAttribute("data-dimension", vm.key);
  spanMissing.hidden = true;
  gauge.appendChild(spanMissing);

  return gauge;
}

/**
 * Renders exactly six Score_Gauges into the gauges container (`id="gauges"`),
 * one per dimension in canonical {@link DIMENSION_KEYS} order (Req 7.1). The
 * container is cleared first so a re-render never leaves stale gauges behind.
 * Each gauge is built from {@link buildGaugeViewModel} (score, reasoning, and
 * base value sourced verbatim from `evaluation.dimensions[key]`, Req 2.1, 7.2,
 * 7.3) via {@link buildGaugeElement}. Fully guarded: absent container → no-op.
 *
 * @param {{ dimensions: { [key: string]: { score: number, span: string, reasoning: string } } }} evaluation
 *   The verbatim `Evaluation_Result`.
 * @returns {void}
 */
function renderGauges(evaluation) {
  const container = getEl("gauges");
  if (container === null) {
    return;
  }

  // Clear any previously rendered gauges before re-rendering (Req 7.1).
  container.textContent = "";

  const dimensions = evaluation ? evaluation.dimensions : undefined;
  if (!dimensions) {
    return;
  }

  // Render exactly six gauges in canonical order (Req 7.1).
  for (const key of DIMENSION_KEYS) {
    const vm = buildGaugeViewModel(key, dimensions[key]);
    container.appendChild(buildGaugeElement(vm));
  }
}

/**
 * The success-path render entry point the task-7.3 state machine calls after a
 * successful pipeline run. In THIS task it renders the overall band (Req 8.1,
 * 8.2) and the six score gauges (Req 2.1, 7.1–7.5, 13.1), both sourced verbatim
 * from the module-produced `evaluation`. It then invokes the later render
 * slices — feedback cards (task 8.2), highlights (task 8.3), and the demo
 * indicator (task 8.4) — ONLY through `typeof` guards, so this file is complete
 * and runnable before those tasks define them (they extend this entry point).
 *
 * Hoisted function declaration so `typeof renderResults === "function"` in
 * {@link handleEvaluateClick} resolves regardless of source order.
 *
 * @param {Object} classification - The verbatim `Classification_Result` (unused
 *   here; carried for the later slices' signatures and future use).
 * @param {{ band: number, dimensions: Object }} evaluation - The verbatim
 *   `Evaluation_Result` whose band and dimensions are rendered.
 * @param {string} essayText - The current essay text (used by task 8.3 to
 *   locate spans; forwarded here so the extension point has it).
 * @returns {void}
 */
function renderResults(classification, evaluation, essayText) {
  // Band — rendered exactly as returned, no recomputation (Req 8.1, 8.2).
  renderBand(evaluation);

  // Six gauges in canonical order, values verbatim from the result (Req 7.1).
  renderGauges(evaluation);

  // Extension points for later slices — called only when already defined so
  // this slice stands alone (tasks 8.2 / 8.3 / 8.4 add these functions).
  if (typeof renderFeedbackCards === "function") {
    // eslint-disable-next-line no-undef
    renderFeedbackCards(evaluation);
  }
  if (typeof renderHighlights === "function" && evaluation) {
    // eslint-disable-next-line no-undef
    renderHighlights(essayText, evaluation.dimensions);
  }
  if (typeof renderDemoIndicator === "function") {
    // eslint-disable-next-line no-undef
    renderDemoIndicator();
  }
}

/**
 * Clears every rendered result so a failed (or re-requested) evaluation never
 * leaves a stale or partial result on screen (Req 6.7, 6.8, 11.3). It empties
 * the band display, the gauges container, and the feedback cards container, and
 * resets the span-not-located indications. When task 8.3's highlight clear path
 * (`renderHighlights`) is present it is invoked with empty inputs to reset the
 * backdrop overlay; otherwise the backdrop is left untouched by this slice.
 *
 * Hoisted function declaration so `typeof clearResults === "function"` in
 * {@link clearRenderedResults} (task 7.3) resolves regardless of source order.
 * Every DOM touch is guarded so this is a safe no-op in a headless context.
 *
 * @returns {void}
 */
function clearResults() {
  // Band display.
  const bandEl = getEl("band-display");
  if (bandEl !== null) {
    bandEl.textContent = "";
    bandEl.removeAttribute("data-band");
  }

  // Gauges container (also drops the per-gauge span-not-located slots).
  const gauges = getEl("gauges");
  if (gauges !== null) {
    gauges.textContent = "";
  }

  // Feedback cards container (populated by task 8.2).
  const cards = getEl("feedback-cards");
  if (cards !== null) {
    cards.textContent = "";
  }

  // Highlight indications — delegate to task 8.3's clear path when present,
  // passing empty inputs so the backdrop resets to no highlights.
  if (typeof renderHighlights === "function") {
    // eslint-disable-next-line no-undef
    renderHighlights("", {});
  }
}
/* ===========================================================================
 * Task 8.2 — Render the UW feedback cards
 *
 * This slice extends the task-8.1 render layer. `renderResults` already calls
 * `renderFeedbackCards(evaluation)` through a `typeof` guard; this task defines
 * that function. It renders the UW_Feedback_Cards below the gauges
 * (id="feedback-cards"), sourced entirely and verbatim from the module-produced
 * `Evaluation_Result` — the frontend never substitutes a self-computed value
 * (Req 9.1, 2.1).
 *
 * Three cards are rendered (per the design's UW_Feedback_Cards section):
 *
 *   1. Mechanics card (Req 9.2, 9.3): when `mechanics_pass === false`, list each
 *      string in `mechanics_errors`; when `true`, show a pass indication and NO
 *      error entries.
 *   2. Suggested Revisions card (Req 9.4): exactly the three entries in
 *      `revisions`, each showing `original`, `suggested`, and `reasoning`.
 *   3. Claims card (Req 9.6, 9.7): each string in `claims`; when `claims` is an
 *      empty array, no claim entries are created (the card header is still
 *      rendered, minimal, with an empty list).
 *
 * There is intentionally NO profile-flags card: this iteration collects no
 * StudentProfile and never calls `evaluateProfile`, so there is no `flags`
 * source. Req 9.5 is satisfied vacuously — the card is simply not rendered.
 *
 * Every piece of text is written via `textContent` (never `innerHTML` of
 * model-derived strings), so no mechanics error, revision field, or claim id
 * can inject markup (consistent with the task-8.1 safety strategy).
 *
 * Hoisted function declaration so the task-7.3 / task-8.1
 * `typeof renderFeedbackCards === "function"` guards resolve it regardless of
 * source order. The container lookup is guarded so this is a safe no-op in a
 * headless context or before task 10.1 adds the markup.
 * ======================================================================== */

/**
 * Builds a detached card element with a titled header and a body the caller
 * fills. Centralizes the card shell (class="card", a header, and a body) so the
 * three cards share a consistent, style-able structure. The title is written via
 * `textContent`; only the fixed section titles ("Mechanics", "Suggested
 * Revisions", "Claims") flow through here, never model-derived text.
 *
 * @param {string} title - The card's section title.
 * @param {string} kind - A stable tag written to `data-card` so CSS and the test
 *   harness can target a specific card (e.g. "mechanics", "revisions",
 *   "claims") without parsing the title copy.
 * @returns {{ card: HTMLElement, body: HTMLElement }} The card element and its
 *   body container for the caller to populate.
 */
function buildFeedbackCard(title, kind) {
  const card = document.createElement("section");
  card.className = "card";
  card.setAttribute("data-card", kind);

  const header = document.createElement("h3");
  header.className = "card-title";
  header.textContent = title;
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "card-body";
  card.appendChild(body);

  return { card, body };
}

/**
 * Builds the Mechanics card (Req 9.2, 9.3) from the verbatim `evaluation`.
 *
 * When `mechanics_pass` is strictly `false`, the card lists each string in
 * `mechanics_errors` as a separate list item (Req 9.2). When `mechanics_pass` is
 * strictly `true`, the card shows a pass indication ("Mechanics: Pass") and NO
 * error entries (Req 9.3). The `mechanics_pass` value is read exactly as
 * returned — the frontend never recomputes it.
 *
 * All text flows through `textContent`, so a mechanics-error string can never
 * inject markup.
 *
 * @param {{ mechanics_pass: boolean, mechanics_errors?: string[] }} evaluation
 *   The verbatim `Evaluation_Result`.
 * @returns {HTMLElement} The detached Mechanics card element.
 */
function buildMechanicsCard(evaluation) {
  const { card, body } = buildFeedbackCard("Mechanics", "mechanics");

  const pass = evaluation ? evaluation.mechanics_pass === true : false;

  if (pass) {
    // Pass path (Req 9.3): a pass indication and NO error entries.
    const passEl = document.createElement("p");
    passEl.className = "mechanics-pass";
    passEl.textContent = "Mechanics: Pass";
    body.appendChild(passEl);
    return card;
  }

  // Fail path (Req 9.2): list each mechanics_errors string as its own item.
  const errors = evaluation && Array.isArray(evaluation.mechanics_errors)
    ? evaluation.mechanics_errors
    : [];

  const list = document.createElement("ul");
  list.className = "mechanics-errors";
  for (const error of errors) {
    const item = document.createElement("li");
    item.className = "mechanics-error";
    item.textContent = typeof error === "string" ? error : String(error);
    list.appendChild(item);
  }
  body.appendChild(list);

  return card;
}

/**
 * Builds the Suggested Revisions card (Req 9.4) from the verbatim `evaluation`.
 *
 * Renders exactly the entries in `evaluation.revisions` (the module guarantees
 * exactly three), each as its own block showing the revision's `original`,
 * `suggested`, and `reasoning` under clear labels (Original / Suggested / Why).
 * Every field is written via `textContent`, so no revision text can inject
 * markup. The entries are rendered verbatim and in order — the frontend adds,
 * drops, or reorders nothing.
 *
 * @param {{ revisions?: Array<{ original: string, suggested: string, reasoning: string }> }} evaluation
 *   The verbatim `Evaluation_Result`.
 * @returns {HTMLElement} The detached Suggested Revisions card element.
 */
function buildRevisionsCard(evaluation) {
  const { card, body } = buildFeedbackCard("Suggested Revisions", "revisions");

  const revisions = evaluation && Array.isArray(evaluation.revisions)
    ? evaluation.revisions
    : [];

  const list = document.createElement("ol");
  list.className = "revisions";

  for (const revision of revisions) {
    const item = document.createElement("li");
    item.className = "revision";

    // Original / Suggested / Why — each a labeled field, all via textContent.
    item.appendChild(buildRevisionField("Original", revision ? revision.original : undefined));
    item.appendChild(buildRevisionField("Suggested", revision ? revision.suggested : undefined));
    item.appendChild(buildRevisionField("Why", revision ? revision.reasoning : undefined));

    list.appendChild(item);
  }

  body.appendChild(list);
  return card;
}

/**
 * Builds one labeled field (`<label>: <value>`) of a revision entry. The fixed
 * label ("Original" / "Suggested" / "Why") and the model-derived value are both
 * written via `textContent`, so the revision text can never inject markup.
 *
 * @param {string} label - The field label (fixed, not model-derived).
 * @param {unknown} value - The revision field value (model-derived).
 * @returns {HTMLElement} The detached field element.
 */
function buildRevisionField(label, value) {
  const field = document.createElement("p");
  field.className = `revision-field revision-${label.toLowerCase()}`;

  const labelEl = document.createElement("span");
  labelEl.className = "revision-label";
  labelEl.textContent = `${label}: `;
  field.appendChild(labelEl);

  const valueEl = document.createElement("span");
  valueEl.className = "revision-value";
  valueEl.textContent = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  field.appendChild(valueEl);

  return field;
}

/**
 * Builds the Claims card (Req 9.6, 9.7) from the verbatim `evaluation`.
 *
 * Renders each Claim_Id string in `evaluation.claims` as its own list item
 * (Req 9.6). When `claims` is an empty array, NO claim entries are created — the
 * card header is still rendered with an empty list, so no claim entries appear
 * (Req 9.7). Each claim id is written via `textContent`.
 *
 * @param {{ claims?: string[] }} evaluation - The verbatim `Evaluation_Result`.
 * @returns {HTMLElement} The detached Claims card element.
 */
function buildClaimsCard(evaluation) {
  const { card, body } = buildFeedbackCard("Claims", "claims");

  const claims = evaluation && Array.isArray(evaluation.claims)
    ? evaluation.claims
    : [];

  const list = document.createElement("ul");
  list.className = "claims";

  // Empty claims → no list items created (Req 9.7); the header/empty list stay.
  for (const claim of claims) {
    const item = document.createElement("li");
    item.className = "claim";
    item.textContent = typeof claim === "string" ? claim : String(claim);
    list.appendChild(item);
  }

  body.appendChild(list);
  return card;
}

/**
 * Renders the UW_Feedback_Cards into the feedback-cards container
 * (`id="feedback-cards"`), below the gauges (Req 9.1). The container is cleared
 * first so a re-render never leaves stale cards behind. Every card is sourced
 * verbatim from the module-produced `Evaluation_Result` (Req 2.1).
 *
 * Renders three cards in order:
 *   1. Mechanics  — pass indication or listed errors (Req 9.2, 9.3).
 *   2. Suggested Revisions — the three revisions with original/suggested/why
 *      (Req 9.4).
 *   3. Claims     — each claim id, none when the array is empty (Req 9.6, 9.7).
 *
 * No profile-flags card is rendered: this iteration collects no StudentProfile
 * and never calls `evaluateProfile`, so there is no `flags` source — Req 9.5 is
 * satisfied vacuously.
 *
 * Hoisted function declaration so the task-8.1 `typeof renderFeedbackCards`
 * guard resolves it regardless of source order. The container lookup is guarded,
 * so this is a safe no-op when the container is absent (headless/test context or
 * before task 10.1 adds the markup).
 *
 * @param {{
 *   mechanics_pass: boolean,
 *   mechanics_errors?: string[],
 *   revisions?: Array<{ original: string, suggested: string, reasoning: string }>,
 *   claims?: string[]
 * }} evaluation - The verbatim `Evaluation_Result`.
 * @returns {void}
 */
function renderFeedbackCards(evaluation) {
  const container = getEl("feedback-cards");
  if (container === null) {
    return;
  }

  // Clear any previously rendered cards before re-rendering (Req 9.1).
  container.textContent = "";

  if (!evaluation) {
    return;
  }

  // 1. Mechanics card (Req 9.2, 9.3).
  container.appendChild(buildMechanicsCard(evaluation));

  // 2. Suggested Revisions card (Req 9.4).
  container.appendChild(buildRevisionsCard(evaluation));

  // 3. Claims card (Req 9.6, 9.7).
  container.appendChild(buildClaimsCard(evaluation));

  // No profile-flags card this iteration — no StudentProfile / evaluateProfile,
  // so there is no `flags` source (Req 9.5 satisfied vacuously).
}
/* ===========================================================================
 * Task 8.3 — Render highlights into the backdrop overlay and wire clear-on-edit
 *
 * This slice extends the task-8.1 render layer and completes the backdrop-
 * overlay highlight mechanism (design "Essay_Input / Essay_Display and the
 * highlight mechanism"). `renderResults` (task 8.1) already calls
 * `renderHighlights(essayText, evaluation.dimensions)` through a `typeof` guard,
 * and `clearResults` (task 8.1) calls `renderHighlights("", {})` to reset the
 * overlay — this task defines `renderHighlights`.
 *
 * The backdrop-overlay technique (design decision): a `<div id="essay-backdrop">`
 * sits directly behind a transparent-text `<textarea id="essay-input">` with
 * identical box metrics and `white-space: pre-wrap; word-break: break-word;`
 * (task 11.1 CSS). The reviewer reads the glyphs painted by the backdrop while
 * editing in the native textarea. This task paints that backdrop: plain text
 * for uncovered runs and `<mark class="hl">` for covered runs (Req 10.1, 10.2,
 * 10.4, 10.7), reveals the per-gauge "span not located" slots for unlocated
 * dimensions (Req 10.5), keeps the backdrop scroll-synced to the textarea, and
 * clears all highlights + not-located indications on edit (Req 10.6).
 *
 * All backdrop text is written as text nodes / `textContent` (never `innerHTML`
 * of essay-derived content), so the essay's characters, whitespace, and line
 * breaks survive exactly and no span text can inject markup (Req 10.2, 10.7).
 *
 * Element IDs (shared with task 10.1 HTML and task 11.1 CSS):
 *   - essay textarea:        id="essay-input"
 *   - highlight backdrop:    id="essay-backdrop"
 *   - per-gauge span slots:  id="span-missing-{key}" (built by task 8.1)
 * ======================================================================== */

/**
 * The reviewer-facing text shown in a gauge's "span not located" slot when that
 * dimension's verbatim span could not be found in the current essay (Req 10.5).
 * Kept as a single constant so the reveal path (task 8.3) and any future copy
 * change share one source of truth.
 *
 * @type {string}
 */
const SPAN_NOT_LOCATED_MESSAGE = "Span not located in essay.";

/**
 * Updates every per-gauge "span not located" slot to reflect the current
 * highlight computation (Req 10.5). For each canonical dimension key, the slot
 * element is `id="span-missing-{key}"` (built empty and hidden by task 8.1's
 * {@link buildGaugeElement}). A key present in `notLocated` reveals its slot
 * (`hidden = false`) with the {@link SPAN_NOT_LOCATED_MESSAGE}; a key NOT in
 * `notLocated` resets its slot (`hidden = true`, text cleared) so a stale
 * indication from a prior evaluation never lingers.
 *
 * Every lookup is guarded via {@link getEl}, so a missing slot (headless/test
 * context, or before task 10.1/8.1 markup exists) is simply skipped.
 *
 * @param {string[]} notLocated - Canonical dimension keys whose span was not
 *   located (from {@link computeHighlightRanges}).
 * @returns {void}
 */
function updateSpanMissingSlots(notLocated) {
  const missing = Array.isArray(notLocated) ? notLocated : [];

  // Reset or reveal each dimension's slot so the set of visible indications
  // exactly matches the current `notLocated` set (no stale indications).
  for (const key of DIMENSION_KEYS) {
    const slot = getEl(`span-missing-${key}`);
    if (slot === null) {
      continue;
    }

    if (missing.indexOf(key) !== -1) {
      // This dimension's span could not be located — reveal and label the slot.
      slot.hidden = false;
      slot.textContent = SPAN_NOT_LOCATED_MESSAGE;
    } else {
      // Located (or not evaluated) — hide and clear any prior indication.
      slot.hidden = true;
      slot.textContent = "";
    }
  }
}

/**
 * Builds the human-readable `aria-label` for a highlighted `<mark>` run, naming
 * the contributing dimension(s) so the highlight is conveyed without relying on
 * color (Req 13.2, 13.3). The canonical dimension keys are mapped through
 * {@link DimensionLabelMap} to their reviewer-facing labels and joined with
 * commas, e.g. `["focus","specificity"]` → `"Highlighted: Focus, Specificity"`.
 * Unknown keys fall back to the raw key so the label is never empty for a
 * contributing dimension.
 *
 * @param {string[]} dimensions - The contributing dimension keys for the run
 *   (canonical order, from the merged {@link HighlightRange}).
 * @returns {string} The `aria-label` text.
 */
function buildHighlightAriaLabel(dimensions) {
  const keys = Array.isArray(dimensions) ? dimensions : [];
  const labels = keys.map((key) => DimensionLabelMap[key] || key);
  return `Highlighted: ${labels.join(", ")}`;
}

/**
 * Paints `segments` into the backdrop element, clearing it first. Each plain
 * segment becomes a text node and each highlighted segment becomes a
 * `<mark class="hl">` whose `textContent` is the RAW segment text — using text
 * nodes / `textContent` (never `innerHTML`) so whitespace and line breaks are
 * preserved exactly under `white-space: pre-wrap` and no essay text can inject
 * markup (Req 10.2, 10.7). Each `<mark>` carries:
 *   - `aria-label` naming its contributing dimension(s) (Req 13.2, 13.3), and
 *   - `data-dimensions` with the keys joined by comma for test targeting.
 * The `hl` class also carries the non-color underline indicator (task 11.1 CSS,
 * Req 13.2).
 *
 * The backdrop lookup is guarded, so this is a safe no-op when the element is
 * absent (headless/test context or before task 10.1 adds the markup).
 *
 * @param {BackdropSegment[]} segments - The ordered segments from
 *   {@link buildBackdropSegments}.
 * @returns {void}
 */
function paintBackdrop(segments) {
  const backdrop = getEl("essay-backdrop");
  if (backdrop === null) {
    return;
  }

  // Clear the backdrop before repainting so no prior highlight run survives.
  backdrop.textContent = "";

  const runs = Array.isArray(segments) ? segments : [];
  for (const segment of runs) {
    const text = segment && typeof segment.text === "string" ? segment.text : "";

    if (segment && segment.highlighted) {
      // Covered run → <mark class="hl"> with the raw text as a text node so
      // whitespace/line breaks survive and no markup is injected (Req 10.7).
      const mark = document.createElement("mark");
      mark.className = "hl";
      mark.textContent = text;

      const dimensions = Array.isArray(segment.dimensions) ? segment.dimensions : [];
      // Accessible, non-color annotation naming the dimension(s) (Req 13.2, 13.3).
      mark.setAttribute("aria-label", buildHighlightAriaLabel(dimensions));
      // Stable hook for the test harness to assert which dimensions a run carries.
      mark.setAttribute("data-dimensions", dimensions.join(","));

      backdrop.appendChild(mark);
    } else {
      // Uncovered run → a plain text node (textContent-equivalent, no markup).
      backdrop.appendChild(document.createTextNode(text));
    }
  }
}

/**
 * Renders the verbatim span highlights into the backdrop overlay for the current
 * essay (Req 10.1, 10.2, 10.4, 10.7) and reveals the per-gauge "span not
 * located" indications for any dimension whose span could not be found
 * (Req 10.5), also resetting the slots of located dimensions so no stale
 * indication lingers.
 *
 * Pipeline:
 *   1. {@link computeHighlightRanges}(`essayText`, `dimensions`) → the union-
 *      merged, non-overlapping `ranges` plus the `notLocated` dimension keys.
 *   2. {@link buildBackdropSegments}(`essayText`, `ranges`) → the ordered plain/
 *      highlighted segment list covering the essay exactly once.
 *   3. {@link paintBackdrop}(segments) → paint the backdrop with text nodes and
 *      `<mark class="hl">` runs (each with its `aria-label` + `data-dimensions`,
 *      Req 13.2, 13.3).
 *   4. {@link updateSpanMissingSlots}(`notLocated`) → reveal/reset the per-gauge
 *      slots (Req 10.5).
 *
 * The clear path (task 8.1's `clearResults`, and the on-edit handler in
 * {@link wireClearOnEdit}) calls this with `("", {})`: `computeHighlightRanges`
 * yields no ranges, `buildBackdropSegments("")` yields no segments, the backdrop
 * is cleared, and every span-not-located slot is reset — so the overlay resets
 * cleanly (Req 10.6).
 *
 * HOISTED function declaration so the task-8.1 `typeof renderHighlights`
 * guards in `renderResults` / `clearResults` resolve it regardless of source
 * order. Every DOM touch is guarded (via {@link getEl} / {@link paintBackdrop}),
 * so this is a safe no-op in a headless/test context.
 *
 * @param {string} essayText - The current essay text to locate spans within.
 * @param {{ [key: string]: { span?: unknown } }} dimensions - The
 *   `Evaluation_Result.dimensions` six-key object.
 * @returns {void}
 */
function renderHighlights(essayText, dimensions) {
  // 1. Locate spans and union-merge into non-overlapping ranges (Req 10.2–10.5).
  const { ranges, notLocated } = computeHighlightRanges(essayText, dimensions);

  // 2. Segment the essay into plain/highlighted runs covering it exactly once.
  const segments = buildBackdropSegments(essayText, ranges);

  // 3. Paint the backdrop with text nodes + <mark class="hl"> runs (Req 10.1,
  //    10.2, 10.4, 10.7, 13.2, 13.3).
  paintBackdrop(segments);

  // 4. Reveal "span not located" indications, resetting located dimensions'
  //    slots so no stale indication survives (Req 10.5).
  updateSpanMissingSlots(notLocated);
}

/**
 * Resets the backdrop overlay to the plain (unhighlighted) escaped text of the
 * essay textarea's current value, and clears every span-not-located indication
 * (Req 10.6). Called by the `input` handler installed in {@link wireClearOnEdit}
 * so that, the moment the reviewer edits after an evaluation, all `<mark>` runs
 * and all not-located indications disappear before the next evaluation renders.
 *
 * Implementation: {@link buildBackdropSegments}(value, []) produces a single
 * plain segment spanning the whole value (or none when empty), which
 * {@link paintBackdrop} paints as a lone text node — i.e. the current essay text
 * with no highlights, whitespace/line breaks preserved under `white-space:
 * pre-wrap`. {@link updateSpanMissingSlots}([]) then hides and clears every
 * per-gauge slot. All DOM touches are guarded.
 *
 * @returns {void}
 */
function clearHighlightsOnEdit() {
  const essayInput = getEl("essay-input");
  const value = essayInput !== null && typeof essayInput.value === "string"
    ? essayInput.value
    : "";

  // Repaint the backdrop with NO highlights so it keeps mirroring the textarea
  // glyphs while the reviewer edits (empty ranges → one plain run).
  paintBackdrop(buildBackdropSegments(value, []));

  // Clear all span-not-located indications (Req 10.6).
  updateSpanMissingSlots([]);
}

/**
 * Syncs the backdrop's scroll offsets to the textarea's on every `scroll` event
 * so the painted glyphs stay aligned with the caret as the reviewer scrolls a
 * long essay (design: "The backdrop scrolls in sync with the textarea via a
 * `scroll` listener"). The backdrop is non-interactive (CSS `pointer-events:
 * none`, task 11.1), so only the textarea emits scroll events; this mirrors its
 * `scrollTop`/`scrollLeft` onto the backdrop.
 *
 * Idempotent: a `data-scroll-synced` flag on the textarea guards against binding
 * the listener more than once across repeated bootstrap calls. Fully guarded, so
 * it is a safe no-op when either element is absent (headless/test context or
 * before task 10.1 adds the markup).
 *
 * HOISTED and exported so the init/bootstrap step (task 8.4 / 10.1) can call it.
 *
 * @returns {void}
 */
export function wireBackdropScrollSync() {
  const essayInput = getEl("essay-input");
  const backdrop = getEl("essay-backdrop");
  if (essayInput === null || backdrop === null) {
    return;
  }

  // Guard against double-binding across repeated bootstrap calls.
  if (essayInput.dataset && essayInput.dataset.scrollSynced === "true") {
    return;
  }

  essayInput.addEventListener("scroll", () => {
    backdrop.scrollTop = essayInput.scrollTop;
    backdrop.scrollLeft = essayInput.scrollLeft;
  });

  if (essayInput.dataset) {
    essayInput.dataset.scrollSynced = "true";
  }
}

/**
 * Wires the clear-on-edit behavior (Req 10.6): attaches an `input` listener to
 * the essay textarea (`id="essay-input"`) that, on any edit, resets the backdrop
 * to the plain escaped text of the textarea's current value and clears all
 * highlights and span-not-located indications via {@link clearHighlightsOnEdit}.
 * It also wires the backdrop scroll sync via {@link wireBackdropScrollSync} so a
 * single bootstrap call sets up both the edit and scroll listeners.
 *
 * Idempotent: a `data-clear-wired` flag on the textarea guards against binding
 * the `input` listener more than once across repeated bootstrap calls. Fully
 * guarded, so it is a safe no-op when the textarea is absent (headless/test
 * context or before task 10.1 adds the markup).
 *
 * HOISTED and exported so the init/bootstrap step (task 8.4 / 10.1) can call it.
 *
 * @returns {void}
 */
export function wireClearOnEdit() {
  const essayInput = getEl("essay-input");
  if (essayInput === null) {
    return;
  }

  // Keep the backdrop scroll-synced to the textarea (own idempotency guard).
  wireBackdropScrollSync();

  // Guard against double-binding the input listener across bootstrap calls.
  if (essayInput.dataset && essayInput.dataset.clearWired === "true") {
    return;
  }

  // On any edit, clear highlights + not-located indications before the next
  // evaluation renders (Req 10.6).
  essayInput.addEventListener("input", () => {
    clearHighlightsOnEdit();
  });

  if (essayInput.dataset) {
    essayInput.dataset.clearWired = "true";
  }
}
/* ===========================================================================
 * Task 8.4 — Render the demo indicator, prompt-selection text, and the
 *            application bootstrap (init)
 *
 * This slice completes the DOM render/wiring layer. It adds the three pieces the
 * prior slices referenced through `typeof` guards or deferred to the bootstrap:
 *
 *   1. `renderDemoIndicator()` — reveals the persistent demo-mode banner while
 *      the mock invoker is the active LLM (Req 11.5). `renderResults` (task 8.1)
 *      already calls this through a `typeof` guard; this task defines it.
 *   2. The Common App `Prompt_Selector` handling (Req 4.3, 4.4) — the seven
 *      standard 2024–2025 Common App prompts, a `wirePromptSelector()` that
 *      populates the `<select id="prompt-select">` and shows the full selected
 *      prompt text in `id="prompt-text"` on change. The selection is
 *      DISPLAY/CONTEXT ONLY — it is never read by, or passed to, any pipeline
 *      module (Req 4.4).
 *   3. `init()` — the bootstrap entry point (task 10.1's HTML triggers it on
 *      `DOMContentLoaded`). It injects the mock so demo mode is active from the
 *      start (Req 11.1, 12.1), reveals the demo indicator, wires the prompt
 *      selector, pre-populates the essay editor with the bundled `SAMPLE_ESSAY`
 *      and paints the backdrop to mirror it (plain, no highlights), wires the
 *      clear-on-edit + scroll-sync behavior, and attaches the Evaluate handler.
 *
 * The status/error area itself is driven by the task-7.3 state machine
 * (`setStatusMessage` / `setRunning`); this slice does not re-implement it, it
 * only ensures the rest of the demo surface is wired around it.
 *
 * All text is written via `textContent` (never `innerHTML` of prompt/essay
 * text), consistent with the safety strategy of the prior slices. Every DOM
 * lookup is guarded so each function is a safe no-op in a headless/test context
 * or before task 10.1 adds the markup.
 *
 * Element IDs (shared with task 10.1 HTML and task 11.1 CSS):
 *   - demo indicator:   id="demo-indicator"
 *   - prompt <select>:  id="prompt-select"
 *   - prompt text:      id="prompt-text"
 *   - essay textarea:   id="essay-input"
 *   - Evaluate button:  id="evaluate-btn"
 * ======================================================================== */

/**
 * The reviewer-facing copy for the persistent demo-mode indicator (Req 11.5).
 * Kept as a single constant so the reveal path and any future copy change share
 * one source of truth.
 *
 * @type {string}
 */
const DEMO_INDICATOR_MESSAGE =
  "Live mode: essays are sent to a real model. Paste your API key in live-llm.js.";

/**
 * Reveals the persistent live-mode indicator (`id="demo-indicator"`) while the
 * live LLM invoker is the active LLM. When {@link isLiveMode} is `true` the
 * indicator element is shown (`hidden = false`) with the
 * {@link DEMO_INDICATOR_MESSAGE}; when the live invoker is NOT active the
 * indicator is hidden and cleared so no stale banner lingers.
 *
 * `renderResults` calls this through a `typeof` guard after a successful
 * evaluation, and {@link init} calls it on bootstrap so the banner is present
 * from the moment the page loads (the live invoker is injected first). The
 * element lookup is guarded via {@link getEl}, so a missing indicator
 * (headless/test context) is a safe no-op.
 *
 * HOISTED function declaration so the `typeof renderDemoIndicator` guard in
 * `renderResults` resolves it regardless of source order.
 *
 * @returns {void}
 */
function renderDemoIndicator() {
  const indicator = getEl("demo-indicator");
  if (indicator === null) {
    return;
  }

  if (isLiveMode()) {
    // The live invoker is active — show the persistent banner.
    indicator.hidden = false;
    indicator.textContent = DEMO_INDICATOR_MESSAGE;
  } else {
    // Not active — hide and clear so no stale banner survives.
    indicator.hidden = true;
    indicator.textContent = "";
  }
}

/**
 * The seven standard 2024–2025 Common App essay prompts, copied verbatim from
 * the design's `Prompt_Selector` section (Req 4.1, 4.2). The array order IS the
 * `<option>` value order: `wirePromptSelector` uses each prompt's index as the
 * option `value` and displays the selected prompt's full text on change.
 *
 * This selection is DISPLAY / CONTEXT ONLY — it is never read by, or passed to,
 * `classifyShape`, `evaluateProfile`, or `evaluateEssay`. No pipeline input or
 * output depends on it (Req 4.3, 4.4). It is exported so the test harness can
 * assert the exact set and ordering of prompts.
 *
 * @type {ReadonlyArray<string>}
 */
export const COMMON_APP_PROMPTS = [
  "Some students have a background, identity, interest, or talent that is so meaningful they believe their application would be incomplete without it. If this sounds like you, then please share your story.",
  "The lessons we take from obstacles we encounter can be fundamental to later success. Recount a time when you faced a challenge, setback, or failure. How did it affect you, and what did you learn from the experience?",
  "Reflect on a time when you questioned or challenged a belief or idea. What prompted your thinking? What was the outcome?",
  "Reflect on something that someone has done for you that has made you happy or thankful in a surprising way. How has this gratitude affected or motivated you?",
  "Discuss an accomplishment, event, or realization that sparked a period of personal growth and a new understanding of yourself or others.",
  "Describe a topic, idea, or concept you find so engaging that it makes you lose all track of time. Why does it captivate you? What or who do you turn to when you want to learn more?",
  "Share an essay on any topic of your choice. It can be one you've already written, one that responds to a different prompt, or one of your own design.",
];

/**
 * The maximum number of characters shown in a prompt `<option>`'s label before
 * it is truncated with an ellipsis. The full prompt text is always shown in the
 * `id="prompt-text"` display on change; the `<option>` label is only a short,
 * scannable preview so the dropdown stays readable.
 *
 * @type {number}
 */
const PROMPT_OPTION_LABEL_MAX = 60;

/**
 * Builds a short, scannable `<option>` label for a Common App prompt: the
 * 1-based prompt number followed by a truncated preview of the prompt text
 * (truncated to {@link PROMPT_OPTION_LABEL_MAX} characters on a word boundary
 * with a trailing ellipsis when longer). The full prompt text is shown
 * separately in the `id="prompt-text"` display, so the label need only be a
 * preview. Written via `textContent` by the caller.
 *
 * @param {string} prompt - The full prompt text.
 * @param {number} index - The zero-based index of the prompt in
 *   {@link COMMON_APP_PROMPTS}.
 * @returns {string} The option label (e.g. `"1. Some students have a …"`).
 */
function buildPromptOptionLabel(prompt, index) {
  const number = index + 1;
  const text = typeof prompt === "string" ? prompt : "";

  if (text.length <= PROMPT_OPTION_LABEL_MAX) {
    return `${number}. ${text}`;
  }

  // Truncate on a word boundary within the budget, then add an ellipsis.
  const slice = text.slice(0, PROMPT_OPTION_LABEL_MAX);
  const lastSpace = slice.lastIndexOf(" ");
  const preview = (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd();
  return `${number}. ${preview}…`;
}

/**
 * Displays the full text of the selected Common App prompt in the prompt-text
 * element (`id="prompt-text"`) via `textContent` (Req 4.3). The `index` is read
 * from the `<select>`'s current value; out-of-range or non-numeric values clear
 * the display rather than throwing. This is the ONLY thing a prompt selection
 * drives — the text is shown for reviewer context and is never passed to any
 * pipeline module (Req 4.4). The lookup is guarded, so a missing element is a
 * safe no-op.
 *
 * @param {number} index - The zero-based index into {@link COMMON_APP_PROMPTS}.
 * @returns {void}
 */
function renderSelectedPromptText(index) {
  const promptText = getEl("prompt-text");
  if (promptText === null) {
    return;
  }

  const prompt = COMMON_APP_PROMPTS[index];
  // Full prompt text for reviewer context; display-only, never an LLM input.
  promptText.textContent = typeof prompt === "string" ? prompt : "";
}

/**
 * Populates the Common App `Prompt_Selector` (`<select id="prompt-select">`)
 * with the seven {@link COMMON_APP_PROMPTS} as `<option>`s and wires its
 * display-only behavior (Req 4.1, 4.2, 4.3, 4.4).
 *
 * Each `<option>`'s `value` is the prompt's zero-based index and its label is a
 * short preview from {@link buildPromptOptionLabel}; the `<select>` is cleared
 * first so repeated bootstrap calls never duplicate options. A `change` listener
 * shows the selected prompt's FULL text in `id="prompt-text"` via
 * {@link renderSelectedPromptText}. An initial selection (the first prompt) is
 * set and its text rendered so the display is never empty on load.
 *
 * The selection is DISPLAY / CONTEXT ONLY: nothing here reads into, or passes
 * the selected prompt to, `classifyShape` / `evaluateProfile` / `evaluateEssay`
 * (Req 4.4). Idempotent: a `data-prompts-wired` flag guards against binding the
 * `change` listener more than once across repeated bootstrap calls.
 *
 * HOISTED function declaration so the bootstrap ({@link init}) can call it
 * regardless of source order. The `<select>` lookup is guarded, so this is a
 * safe no-op when the element is absent (headless/test context or before task
 * 10.1 adds the markup).
 *
 * @returns {void}
 */
function wirePromptSelector() {
  const select = getEl("prompt-select");
  if (select === null) {
    return;
  }

  // Clear any existing options so repeated bootstraps never duplicate them.
  select.textContent = "";

  // Populate the seven prompts as <option>s (value = index, label = preview).
  COMMON_APP_PROMPTS.forEach((prompt, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = buildPromptOptionLabel(prompt, index);
    select.appendChild(option);
  });

  // Bind the change handler once; show the selected prompt's full text on
  // change — display only, never an LLM input (Req 4.3, 4.4).
  if (!(select.dataset && select.dataset.promptsWired === "true")) {
    select.addEventListener("change", () => {
      const index = Number.parseInt(select.value, 10);
      renderSelectedPromptText(index);
    });
    if (select.dataset) {
      select.dataset.promptsWired = "true";
    }
  }

  // Initial selection: the first prompt, with its full text rendered so the
  // display is populated on load.
  select.value = "0";
  renderSelectedPromptText(0);
}

/* ===========================================================================
 * SPA navigation
 *
 * The top nav bar toggles which <main class="view"> section is visible. Active
 * nav links carry `data-view` matching a view's `data-view`; clicking one shows
 * that view (clears `hidden`), hides the others, and moves the `is-active` /
 * `aria-current` state onto the clicked link. Disabled links (the "Coming Soon"
 * items) are plain <span>s with no `data-view`, so they are never wired.
 * ======================================================================== */

/**
 * Shows the view whose `data-view` equals `viewName` and hides every other
 * view, then reflects the active state onto the matching nav link. Guarded so a
 * missing document/view is a safe no-op.
 *
 * @param {string} viewName - The target view's `data-view` value.
 * @returns {void}
 */
export function showView(viewName) {
  if (typeof document === "undefined" || !document.querySelectorAll) {
    return;
  }

  const views = document.querySelectorAll(".view[data-view]");
  views.forEach((view) => {
    const isTarget = view.getAttribute("data-view") === viewName;
    view.hidden = !isTarget;
  });

  const links = document.querySelectorAll(".nav-link[data-view]");
  links.forEach((link) => {
    const isTarget = link.getAttribute("data-view") === viewName;
    if (link.classList) {
      link.classList.toggle("is-active", isTarget);
    }
    if (isTarget) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });
}

/**
 * Wires the top navigation: each active nav link (a `.nav-link[data-view]`)
 * switches the visible view via {@link showView} on click. Idempotent through a
 * `data-nav-wired` flag on the <nav>, and fully guarded so it is a safe no-op
 * without a document.
 *
 * @returns {void}
 */
export function wireNavigation() {
  if (typeof document === "undefined" || !document.querySelectorAll) {
    return;
  }

  // Wire every view-switcher: the top nav links (`.nav-link[data-view]`) AND any
  // other element opted in with `data-view-link` (the landing-page CTAs and the
  // clickable brand mark). Both carry a `data-view` naming the target view.
  const links = document.querySelectorAll(
    ".nav-link[data-view], [data-view-link][data-view]"
  );
  links.forEach((link) => {
    if (link.dataset && link.dataset.navWired === "true") {
      return;
    }
    link.addEventListener("click", () => {
      const view = link.getAttribute("data-view");
      if (view) {
        showView(view);
      }
    });
    if (link.dataset) {
      link.dataset.navWired = "true";
    }
  });

  // Default view on load: the editorial landing page.
  showView("home");
}

/**
 * The application bootstrap / entry point (Req 11.1, 11.5, 12.1, and the demo
 * surface wiring). Task 10.1's HTML triggers this on `DOMContentLoaded` (and the
 * guarded auto-run at the bottom of this module triggers it directly when the
 * document is already parsed). It brings up the full demo in order:
 *
 *   1. {@link installMockLlm}() — inject the demo mock invoker into both ported
 *      modules so demo mode is active from the start and no stage ever hits the
 *      throwing default stub (Req 11.1).
 *   2. {@link renderDemoIndicator}() — reveal the persistent demo-mode banner
 *      now that the mock is active (Req 11.5).
 *   3. {@link wirePromptSelector}() — populate the Common App prompt dropdown
 *      and show the first prompt's text (display-only, Req 4.3, 4.4).
 *   4. Pre-populate the essay editor (`id="essay-input"`) with the bundled
 *      {@link SAMPLE_ESSAY} (via `.value`) and paint the backdrop to mirror it
 *      as PLAIN text with no highlights, so the overlay glyphs match the editor
 *      from the first paint (the backdrop stays aligned while the reviewer
 *      reads/edits before any evaluation).
 *   5. {@link wireClearOnEdit}() — attach the on-edit clear + backdrop
 *      scroll-sync listeners (Req 10.6; it also calls `wireBackdropScrollSync`).
 *   6. Attach {@link handleEvaluateClick} to the Evaluate button
 *      (`id="evaluate-btn"`) `click` event so clicking runs the pipeline.
 *
 * Every DOM touch is guarded (via {@link getEl} and the wiring helpers' own
 * guards), so `init` runs safely in a headless/test context or before task 10.1
 * adds the markup. Idempotent: the mock injection and the wiring helpers are all
 * individually idempotent, and the Evaluate handler is bound through a
 * `data-evaluate-wired` guard so repeated calls never double-bind it.
 *
 * HOISTED and EXPORTED so task 10.1's HTML (and the test harness) can trigger
 * the bootstrap explicitly.
 *
 * @returns {void}
 */
export function init() {
  // 1. Inject the live LLM invoker so it is active from the start.
  installLiveLlm();

  // 2. Reveal the persistent live-mode indicator now that the invoker is active.
  renderDemoIndicator();

  // 3. Populate the Common App prompt selector and show the first prompt's text
  //    (display/context only — never an LLM input, Req 4.3, 4.4).
  wirePromptSelector();

  // 4. Pre-populate the essay editor with the bundled sample essay and paint the
  //    backdrop to mirror it as plain text (no highlights) so the overlay glyphs
  //    align with the editor from the first paint.
  const essayInput = getEl("essay-input");
  if (essayInput !== null) {
    essayInput.value = SAMPLE_ESSAY;
  }
  // Paint the backdrop plain: empty ranges → a single plain run spanning the
  // sample essay (whitespace/line breaks preserved under white-space: pre-wrap).
  paintBackdrop(buildBackdropSegments(SAMPLE_ESSAY, []));
  // No span-not-located indications before any evaluation.
  updateSpanMissingSlots([]);

  // 5. Wire clear-on-edit (and, via it, the backdrop scroll sync) so editing the
  //    pre-populated essay keeps the overlay in sync and clears stale highlights
  //    (Req 10.6).
  wireClearOnEdit();

  // 6. Attach the Evaluate handler so clicking the button runs the pipeline.
  //    Guarded against double-binding across repeated bootstrap calls.
  const evaluateBtn = getEl("evaluate-btn");
  if (evaluateBtn !== null) {
    if (!(evaluateBtn.dataset && evaluateBtn.dataset.evaluateWired === "true")) {
      evaluateBtn.addEventListener("click", handleEvaluateClick);
      if (evaluateBtn.dataset) {
        evaluateBtn.dataset.evaluateWired = "true";
      }
    }
  }

  // 7. Wire the top nav so the Evaluator / About / Resources views toggle, and
  //    show the default (Evaluator) view.
  wireNavigation();
}

/* ---------------------------------------------------------------------------
 * Auto-bootstrap: trigger `init` when the DOM is ready so opening `index.html`
 * brings up the demo without any inline script. Guarded for the test harness —
 * `document` may still exist there, which is fine because every DOM lookup in
 * `init` is itself guarded and all wiring is idempotent. When the document is
 * still parsing we wait for `DOMContentLoaded`; when it is already parsed
 * (`interactive`/`complete`) we run immediately.
 * ------------------------------------------------------------------------- */
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}
