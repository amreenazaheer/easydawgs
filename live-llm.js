// live-llm.js
//
// Live LLM integration for the EasyDawg Frontend (zero-build, browser-native ES
// module). This replaces the bundled `mock-llm.js` demo data with a real model
// call made directly from the browser using the native `fetch()` API — no SDK,
// bundler, or Node runtime.
//
// The exported `liveLlmInvoker` matches the `LlmInvoker` contract that BOTH
// ported pipeline modules call:
//   - shape-classifier.js calls `invoker(request, LLM_TIMEOUT_MS)` — the second
//     argument is a timeout in milliseconds.
//   - evaluator.js routes through its `invokeLlm` wrapper, which calls
//     `llmCall(request, abortSignal)` — the second argument is an AbortSignal.
// The invoker below accepts whichever second argument it is handed and adapts:
// an AbortSignal is forwarded straight to `fetch`; a numeric timeout is turned
// into an AbortController so the request still cancels on time.
//
// Both modules pass the SAME request shape — `{ systemPrompt, userText }` — and
// expect the model's RAW TEXT back (a single JSON object as a string). Each
// module's own `parseResponse` + strict validator is the authoritative guard,
// so this file only has to deliver the model's text; it does not need to know
// the classifier vs. evaluator JSON schemas. We still branch on the system
// prompt purely to pick a sensible `max_tokens` budget for each call.
//
// ---------------------------------------------------------------------------
// PROVIDER: Anthropic (Claude) Messages API.
// Docs: https://docs.anthropic.com/en/api/messages
// ---------------------------------------------------------------------------

/**
 * Your Anthropic API key. Paste it between the quotes before opening the page.
 *
 * SECURITY NOTE: a key placed here is visible to anyone who can open the page
 * and will be sent from the browser. This is fine for a local demo on your own
 * machine, but do NOT deploy this file publicly or commit a real key. For a
 * production app, proxy the call through a tiny backend that holds the key.
 *
 * @type {string}
 */
const API_KEY = "apikeyhere";

/**
 * The Anthropic Messages API endpoint.
 * @type {string}
 */
const API_URL = "https://api.anthropic.com/v1/messages";

/**
 * The model to call. Swap this for any current Anthropic model id.
 * @type {string}
 */
const MODEL = "claude-sonnet-5-5";

/**
 * The Anthropic API version header value (required by the Messages API).
 * @type {string}
 */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Marker substrings that uniquely identify the classifier `SYSTEM_PROMPT`
 * (from shape-classifier.js). Used only to pick a token budget — routing to the
 * correct module is implicit because each module calls with its own prompt.
 * @type {readonly string[]}
 */
const CLASSIFIER_PROMPT_MARKERS = ["classify the structural SHAPE", "SHAPE RULES"];

/**
 * Returns true when `systemPrompt` looks like the classifier prompt.
 * @param {string} systemPrompt
 * @returns {boolean}
 */
function isClassifierPrompt(systemPrompt) {
  const text = typeof systemPrompt === "string" ? systemPrompt : "";
  return CLASSIFIER_PROMPT_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Aggressively extracts the JSON object payload from the model's raw text so the
 * calling module's `JSON.parse` sees a bare, well-formed object — regardless of
 * any conversational filler, preamble, trailing commentary, or Markdown code
 * fences the model may have added around it.
 *
 * Strategy:
 *   1. If the text is wrapped in a Markdown code fence (```json ... ``` or
 *      ``` ... ```), unwrap it first so the fence's own braces/backticks do not
 *      interfere.
 *   2. Starting at the FIRST `{`, walk forward tracking brace depth (while
 *      respecting JSON strings and backslash escapes so braces inside string
 *      values do not count) and return the FIRST COMPLETE, balanced object —
 *      i.e. up to and including the `}` that matches that first `{`. Everything
 *      before the first brace (e.g. "Here is the JSON:") AND everything after
 *      the object closes (trailing commentary, a stray second object, or extra
 *      prose) is discarded. This is what prevents the "Unexpected non-whitespace
 *      character after JSON" error when the model emits more than one object or
 *      adds text after the JSON.
 *
 * When no opening `{` is found (or it never closes), the text from the first
 * brace onward — or the trimmed input — is returned so the caller's `JSON.parse`
 * still throws a meaningful error on genuinely empty or non-JSON output.
 *
 * @param {string} text - The raw text content returned by the model.
 * @returns {string} The isolated JSON object text, trimmed.
 */
function extractJson(text) {
  let trimmed = (typeof text === "string" ? text : "").trim();

  // 1. Unwrap a Markdown code fence if present (```json ... ``` or ``` ... ```).
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i;
  const fenceMatch = trimmed.match(fence);
  if (fenceMatch) {
    trimmed = fenceMatch[1].trim();
  }

  // 2. Find the first "{" and walk to its matching "}", counting brace depth but
  //    ignoring any braces that appear inside a JSON string (and honoring
  //    backslash escapes), so the returned slice is exactly ONE complete object.
  const start = trimmed.indexOf("{");
  if (start === -1) {
    return trimmed;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // Matching close brace for the first "{" — return exactly this object,
        // discarding anything that follows it.
        return trimmed.substring(start, i + 1);
      }
    }
  }

  // Never balanced — return from the first brace on so JSON.parse reports a
  // clear "unterminated" error rather than this helper hiding it.
  return trimmed.substring(start);
}

/**
 * Repairs the most common ways a language model produces ALMOST-valid JSON, so
 * a strict `JSON.parse` succeeds without depending on the model getting escaping
 * perfectly right. This is a deterministic, code-side fallback — it runs ONLY
 * after a strict parse has already failed.
 *
 * It walks the text once, tracking whether the cursor is inside a JSON string
 * (respecting backslash escapes), and fixes:
 *   - Literal control characters inside string values — a raw newline, carriage
 *     return, or tab that the model left unescaped is converted to its JSON
 *     escape (`\n`, `\r`, `\t`). This is the usual cause of both "Unterminated
 *     string" and "Expected property name" parse errors (an unescaped newline
 *     ends the string early, so the next character is read as structure).
 *   - "Smart" punctuation OUTSIDE strings that the model used for structure
 *     (curly double quotes acting as JSON quotes) is converted to ASCII `"`.
 *     Inside strings, smart punctuation is left as-is (it is valid there).
 *   - Trailing commas before a `}` or `]` (outside strings) are removed.
 *
 * It does NOT attempt to parse or restructure the JSON; it only sanitizes
 * characters so a subsequent `JSON.parse` has a chance. If the text is damaged
 * beyond these fixes, the caller's parse still fails and the raw text is logged.
 *
 * @param {string} text - The extracted (de-fenced, brace-isolated) JSON text.
 * @returns {string} A sanitized string more likely to parse as JSON.
 */
function repairJson(text) {
  const input = typeof text === "string" ? text : "";
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      if (escaped) {
        // Previous char was a backslash — emit this char verbatim.
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"' || ch === "\u201C" || ch === "\u201D") {
        // End of the string value. A curly double quote is normalized to a
        // straight quote and treated as a terminator so a model that used curly
        // quotes for STRUCTURE (open and close) still balances. Legitimate curly
        // quotes inside content are rare; models that quote content use straight
        // quotes, so normalizing here is the safer trade-off.
        out += '"';
        inString = false;
        continue;
      }
      // Escape ANY raw control character (U+0000–U+001F) that is illegal inside
      // a JSON string. The common ones (backspace, form feed, newline, carriage
      // return, tab) get their short escapes; every other control code gets a
      // \uXXXX escape. This covers vertical tab, form feed, and other low codes
      // a model can emit that a newline/tab-only pass would miss.
      const code = ch.charCodeAt(0);
      if (code <= 0x1f) {
        if (ch === "\b") {
          out += "\\b";
        } else if (ch === "\f") {
          out += "\\f";
        } else if (ch === "\n") {
          out += "\\n";
        } else if (ch === "\r") {
          out += "\\r";
        } else if (ch === "\t") {
          out += "\\t";
        } else {
          out += "\\u" + code.toString(16).padStart(4, "0");
        }
        continue;
      }
      out += ch;
      continue;
    }

    // --- Outside any string ---

    // A straight or curly double quote opens a JSON string. Normalize a curly
    // opener to a straight quote so structure parses.
    if (ch === '"' || ch === "\u201C" || ch === "\u201D") {
      out += '"';
      inString = true;
      continue;
    }

    // Remove a trailing comma that is immediately followed (ignoring whitespace)
    // by a closing brace or bracket.
    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) {
        j++;
      }
      if (input[j] === "}" || input[j] === "]") {
        // Skip this comma; the structure closes next.
        continue;
      }
      out += ch;
      continue;
    }

    out += ch;
  }

  return out;
}

/**
 * Parses extracted model text as JSON, attempting a deterministic repair pass
 * if the strict parse fails. Returns the JSON STRING that parsed (either the
 * original extracted text or the repaired text), so the caller can forward valid
 * JSON text to the pipeline module. Throws the ORIGINAL parse error when neither
 * the strict nor the repaired text parses.
 *
 * @param {string} extracted - The extracted JSON text from {@link extractJson}.
 * @returns {string} A string that `JSON.parse` accepts.
 * @throws {SyntaxError} The original parse error when repair also fails.
 */
function parseOrRepair(extracted) {
  try {
    JSON.parse(extracted);
    return extracted;
  } catch (firstError) {
    const repaired = repairJson(extracted);
    try {
      JSON.parse(repaired);
      if (typeof console !== "undefined" && typeof console.debug === "function") {
        console.debug("[live-llm] strict JSON.parse failed; repaired text parsed.");
      }
      return repaired;
    } catch {
      // Repair did not help — surface the ORIGINAL error for diagnosis.
      throw firstError;
    }
  }
}

/**
 * Normalizes the two possible second arguments into an `AbortSignal`.
 *
 * - When called by evaluator.js the second argument is already an AbortSignal
 *   (from its internal timeout controller) — it is returned as-is.
 * - When called by shape-classifier.js the second argument is a number of
 *   milliseconds — a fresh AbortController is created and aborted after that
 *   delay, and its signal is returned, so the classifier call still cancels on
 *   timeout even though the module does not supply a signal.
 * - Anything else yields `undefined` (no cancellation wired).
 *
 * @param {AbortSignal | number | undefined} signalOrTimeout
 * @returns {AbortSignal | undefined}
 */
function resolveAbortSignal(signalOrTimeout) {
  // evaluator.js path: an AbortSignal was passed straight through.
  if (
    typeof signalOrTimeout === "object" &&
    signalOrTimeout !== null &&
    typeof signalOrTimeout.aborted === "boolean"
  ) {
    return /** @type {AbortSignal} */ (signalOrTimeout);
  }

  // shape-classifier.js path: a numeric timeout budget was passed.
  if (typeof signalOrTimeout === "number" && Number.isFinite(signalOrTimeout)) {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), signalOrTimeout);
    return controller.signal;
  }

  return undefined;
}

/**
 * The live LLM invoker. Matches the `LlmInvoker` contract both ported modules
 * call: it receives the assembled `{ systemPrompt, userText }` request and a
 * second argument that is either an `AbortSignal` (evaluator.js) or a timeout in
 * milliseconds (shape-classifier.js). It sends a single Anthropic Messages API
 * request via `fetch()` and resolves to the model's RAW TEXT — a single JSON
 * object as a string — which the calling module parses and validates.
 *
 * The `systemPrompt` is sent as the top-level Anthropic `system` field and the
 * `userText` as a single `user` message, exactly as each module's TODO describes
 * ("send systemPrompt as the system message and userText as the user message").
 *
 * On a non-OK HTTP response or a transport failure this throws, which each
 * module maps to its own failure/timeout error class. An aborted request (from
 * the timeout path) surfaces as an `AbortError`, which the modules treat as a
 * failed request.
 *
 * @param {{ systemPrompt: string, userText: string }} req
 *   The request assembled by the calling module's `buildMessages`.
 * @param {AbortSignal | number} [signalOrTimeout]
 *   An AbortSignal (evaluator) or a timeout in ms (classifier).
 * @returns {Promise<string>} The model's raw text response (de-fenced).
 */
export async function liveLlmInvoker(req, signalOrTimeout) {
  const systemPrompt =
    req && typeof req.systemPrompt === "string" ? req.systemPrompt : "";
  const userText = req && typeof req.userText === "string" ? req.userText : "";

  if (API_KEY === "PASTE_KEY_HERE" || API_KEY.trim().length === 0) {
    throw new Error(
      "The live LLM is not configured: paste your API key into live-llm.js (API_KEY)."
    );
  }

  // Guard against the most common mistake: opening index.html as a file. A
  // file:// page has a `null` origin, which the browser refuses to let make a
  // cross-origin request to api.anthropic.com no matter what CORS headers come
  // back. Surface a clear, actionable message instead of an opaque network
  // failure (which the pipeline would otherwise report as a generic failure).
  if (
    typeof location !== "undefined" &&
    location.protocol === "file:"
  ) {
    throw new Error(
      "This page is open as a local file (file://), so the browser blocks the " +
        "cross-origin call to the Anthropic API. Serve it over http://localhost " +
        "instead — e.g. run `npx serve` (or `python -m http.server`) in the " +
        "project folder and open the printed http://localhost URL."
    );
  }

  const signal = resolveAbortSignal(signalOrTimeout);

  // The classifier needs far fewer tokens than the full evaluation; budget
  // accordingly so classifier calls stay fast and evaluations have room.
  const maxTokens = isClassifierPrompt(systemPrompt) ? 512 : 4096;

  // The Anthropic Messages API payload. Shape per
  // https://docs.anthropic.com/en/api/messages:
  //   - `model`:      required model id.
  //   - `max_tokens`: required integer cap on the response.
  //   - `system`:     optional top-level system prompt (NOT a message).
  //   - `messages`:   required array of { role, content } turns. `content` may
  //                   be a plain string (shorthand for a single text block).
  // NOTE: no `temperature` field. Some current Anthropic models reject it with
  // a 400 invalid_request_error ("temperature is deprecated for this model").
  // Determinism is driven by the strict, rule-bound system prompts instead.
  const payload = {
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userText }],
  };

  let response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      // Explicit CORS mode: this is a cross-origin browser request and we want
      // the browser to perform the CORS handshake (not fail silently/opaque).
      mode: "cors",
      // No cookies are involved; keep credentials out so the request stays a
      // simple CORS request authenticated purely by the x-api-key header.
      credentials: "omit",
      headers: {
        "content-type": "application/json",
        // Standard Anthropic API keys (sk-ant-...) authenticate via x-api-key,
        // NOT `Authorization: Bearer` (Bearer is for OAuth tokens and yields
        // "Invalid bearer token" with a normal key).
        "x-api-key": API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        // REQUIRED for any browser-origin call: this opts the request into
        // Anthropic's CORS support so the preflight/response carry the
        // Access-Control-Allow-Origin headers the browser demands.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (networkError) {
    // A thrown fetch (as opposed to a non-2xx response) is a transport/CORS
    // failure: the browser blocked the request or the network is unreachable.
    // Re-throw with a message that names the likely cause so it is diagnosable.
    const detail =
      networkError && typeof networkError.message === "string"
        ? networkError.message
        : String(networkError);
    throw new Error(
      "The request to the Anthropic API could not be sent (network or CORS " +
        "failure). Confirm the page is served over http://localhost and that " +
        "the API key is valid. Underlying error: " +
        detail
    );
  }

  if (!response.ok) {
    // Try to surface Anthropic's structured error ({ error: { type, message } })
    // so auth/quota/validation problems are readable instead of opaque.
    let detail = "";
    try {
      const errBody = await response.json();
      if (errBody && errBody.error && typeof errBody.error.message === "string") {
        detail = `${errBody.error.type || "error"}: ${errBody.error.message}`;
      } else {
        detail = JSON.stringify(errBody);
      }
    } catch {
      try {
        detail = await response.text();
      } catch {
        detail = "";
      }
    }
    throw new Error(
      `The Anthropic API returned HTTP ${response.status}. ${detail}`.trim()
    );
  }

  const data = await response.json();

  // Anthropic returns `content` as an array of blocks; concatenate the text
  // blocks to reconstruct the model's full textual answer.
  const blocks = data && Array.isArray(data.content) ? data.content : [];
  const rawText = blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");

  const extracted = extractJson(rawText);

  // Log the raw model text to the console so that, if a downstream module fails
  // to parse or validate the response, we can see exactly what the model
  // returned (the original text AND what we extracted from it). This is a dev
  // aid; it does not affect control flow.
  if (typeof console !== "undefined" && typeof console.debug === "function") {
    console.debug(
      "[live-llm] raw model text:\n%s\n[live-llm] extracted JSON:\n%s",
      rawText,
      extracted
    );
  }

  // Validate locally so an unparseable/empty payload is logged with the full raw
  // text BEFORE the calling module raises its generic InvalidResponseError.
  // `parseOrRepair` first tries a strict parse, then a deterministic repair pass
  // (escaping stray control characters, normalizing smart quotes, stripping
  // trailing commas) so common model escaping slips do not fail the evaluation.
  // It returns the JSON text that parsed, which is what we forward downstream.
  try {
    return parseOrRepair(extracted);
  } catch (parseError) {
    if (typeof console !== "undefined" && typeof console.error === "function") {
      console.error(
        "[live-llm] Could not parse the model response as JSON, even after " +
          "attempting repair. Raw model text follows:\n%s",
        rawText
      );
    }
    const detail =
      parseError && typeof parseError.message === "string"
        ? parseError.message
        : String(parseError);
    throw new Error(
      "The model did not return valid JSON. See the browser console for the " +
        "raw model output. Parse error: " +
        detail
    );
  }
}
