# EasyDawg

A browser-based college admissions essay reviewer. A student pastes a Common App
essay, clicks **Evaluate**, and gets a structured, rubric-driven assessment: an
overall band, six scored dimensions with highlighted supporting quotes, mechanics
feedback, three suggested revisions, and a set of opaque "claims."

EasyDawg's mission is to democratize the kind of holistic essay read that usually
requires an expensive counselor.

## Technical shape

- **Zero-build, vanilla JS.** No bundler, transpiler, or framework — plain ES
  modules loaded with `<script type="module">`, served as static files.
- **SPA front end** (`index.html` + `app.js` + `styles.css`): a top nav toggles
  three views — **Evaluator Engine** (default), **About Us**, **Resources** —
  plus two greyed-out "Coming Soon" links (Transcripts, Extracurriculars). The
  Evaluator is a split screen: essay editor on the left, feedback dashboard on
  the right. Styling is a polished system-ui aesthetic with soft shadows, rounded
  corners, and animated gauges.
- **Live LLM** (`live-llm.js`): a native `fetch()` call to the Anthropic Messages
  API, injected into the pipeline via `setLlmCall`. It extracts the JSON object
  from the model's text and runs a deterministic repair pass (escaping stray
  newlines/tabs, normalizing smart quotes, stripping trailing commas) so minor
  model formatting slips don't break parsing.
- **Pipeline modules** (ported from TypeScript): `shape-classifier.js` →
  `evaluator.js`. `router.js` (profile-based modifiers) exists but is not wired
  into this iteration.

## The evaluation pipeline

1. **Shape classification** (`shape-classifier.js`): the LLM labels the essay's
   narrative structure as `linear` (chronological/episodic) or `motif` (a
   recurring object/image anchors it), plus a `circularity` boolean. The motif
   rule wins ties; `linear` is the default.
2. **Essay evaluation** (`evaluator.js`): the LLM scores six rubric dimensions,
   each anchored to a **verbatim span** quoted from the essay, and returns a
   mechanics pass/fail, exactly three sentence-level revisions, and claim IDs. A
   tolerant locator re-anchors spans that differ only in whitespace/punctuation,
   and always stores the exact essay slice so highlighting works.

Crucially, the LLM does **not** decide the final grade — it only supplies
per-dimension scores. The band is computed deterministically in code.

## The grading system

### Six dimensions, each with a fixed base value (maximum)

| Dimension      | Base value |
| -------------- | ---------- |
| Focus          | 25         |
| Specificity    | 25         |
| Character      | 20         |
| How You Think  | 20         |
| Contribution   | 15         |
| Self-Awareness | 10         |
| **Total**      | **115**    |

Focus is judged against shape-specific anchors (a coherent through-line for
`linear`; a deepening recurring motif for `motif`).

### Deterministic scoring chain (all in code, no LLM involvement)

1. `scoreDimensions` — take each dimension's raw score verbatim from the LLM
   (already range-checked to `[0, base value]`).
2. `applyProfileModifiers` — add any intake-profile adjustments, then clamp each
   score to `[0, base value]`. (This iteration passes empty modifiers, so scores
   are unchanged.)
3. `computeTotalScore` — sum the six scores into a `Total_Score` in `[0, 115]`.
4. `deriveBand` — map the total onto a 1–5 band across five equal ~23-point
   ranges:

| Total_Score (inclusive) | Band |
| ----------------------- | ---- |
| 0 – 23                  | 1    |
| 24 – 46                 | 2    |
| 47 – 69                 | 3    |
| 70 – 92                 | 4    |
| 93 – 115                | 5    |

## Feedback surfaced in the UI

- **Band** (1–5) as the headline result.
- **Six gauges**, each showing `score / base value`, a fill bar, the LLM's
  reasoning, and the quoted span highlighted in the essay (with a "span not
  located" note if it can't be found).
- **Mechanics card**: pass, or a list of specific errors.
- **Suggested Revisions**: exactly three sentence-level rewrites (original →
  suggested → why).
- **Claims**: opaque claim-ID strings the front end would resolve against a
  resource hub.

## Grounding (Resources view)

The logic is based on published UW admissions guidance:

- **Answer–Evidence–Interpretation** framework — answer the prompt directly,
  ground it in concrete evidence, then interpret what it means. The six
  dimensions map onto this (focus/specificity ≈ answer + evidence;
  how-you-think/character/self-awareness ≈ interpretation).
- **Holistic review criteria** — intellectual curiosity, character and growth,
  contribution, context, and self-awareness; no single number decides an
  application.

## Running it

The app must be served over `http://localhost` (not opened as a `file://` page),
because the browser blocks the cross-origin Anthropic call from a `null` origin.

1. Paste your Anthropic API key into `live-llm.js` (`const API_KEY = "..."`).
2. From the project folder, start a static server, for example:
   ```
   npx serve .
   ```
   (or `python -m http.server`)
3. Open the printed `http://localhost` URL and evaluate an essay.

### Tests

```
npm install
npm test          # vitest
npm run typecheck  # tsc --noEmit
```

## Project structure

| File                              | Role                                                               |
| --------------------------------- | ------------------------------------------------------------------ |
| `index.html`                      | SPA shell: nav bar, Evaluator / About / Resources views.           |
| `app.js`                          | App controller: input gate, pipeline orchestration, rendering, SPA nav. |
| `styles.css`                      | Premium system-ui styling, gauges, cards, content views.           |
| `live-llm.js`                     | Live Anthropic Messages API invoker + JSON extraction/repair.      |
| `shape-classifier.js` / `.ts`     | LLM narrative-shape classifier (`linear` / `motif`).               |
| `evaluator.js` / `.ts`            | LLM scoring + deterministic band derivation + span validation.     |
| `router.js` / `.ts`               | Deterministic profile modifiers (not wired in this iteration).     |
| `evaluator.scaffolding.test.ts`   | Unit tests for the evaluator scaffolding.                          |

## Caveats

- **API key exposure.** The key is pasted into `live-llm.js` and is readable from
  the served page by anyone who can open it. This is fine for a local demo on
  your own machine. Do **not** deploy this file publicly or commit a real key;
  for production, proxy the call through a small backend that holds the key.
  Rotate the key when you are done testing.
- **JSON repair is best-effort.** It fixes common model formatting slips but
  cannot recover genuinely truncated output. If a response is cut off mid-object,
  raise the evaluator's `max_tokens` in `live-llm.js`.
