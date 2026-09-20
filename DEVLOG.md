# Design notes

Things that were not obvious while building this, kept because they would be easy to
get wrong again. Organised by area rather than by date.

## Importing ENEX

`evernote-backup` is the only export route worth using. Evernote Web cannot export
notebooks at all, and the desktop app only does one notebook at a time. The tool logs in
with OAuth, needs no developer token, and writes one `.enex` per notebook.

ENEX has no notebook field, so the notebook name has to come from the file name.

The files run to hundreds of megabytes because every attachment is base64 inline, so the
parser streams with `saxes` rather than building a DOM. Roughly half a second per 100 MB.

An export carries none of Evernote's server-side OCR: there is no `<recognition>`
element. Attachment search has to be rebuilt from scratch, which is what the extraction
pipeline below is for.

## Rendering and sanitising

ENML is close enough to HTML that one renderer handles both directions. Stored HTML goes
back through the same function on every edit, which makes the sanitiser the single gate
for stored content and means the function has to be idempotent on its own output.

Attachment URLs are keyed by the MD5 that ENML's `en-media hash` already references, so
no separate id mapping is needed.

Sanitiser details that took a second pass: browsers strip control characters and
whitespace *inside* a URL scheme, so `java&#9;script:` has to be normalised before the
scheme is checked; `svg`, `math`, `form`, `button`, `meta`, `base`, `link` and `template`
all need dropping outright; and the URL check has to apply to every attribute, not just
`href` and `src`.

Checkbox state has to be mirrored onto the `checked` attribute by hand, because
`innerHTML` serialises attributes and not properties.

## Search

FTS5 external-content tables require the index columns to be named exactly like the
content table's columns. Getting this wrong produces `no such column` errors from inside
the triggers, which is confusing to trace. The migration now verifies the index DDL and
rebuilds when it does not match.

Rank by `bm25()` with the title weighted heavily, not by date. Sorting by date buries an
old but exact match under recent noise.

With a query, list snippets come from FTS5 `snippet()`, so a match inside an attachment
is visible in the list rather than only in the note.

## Text extraction

Two sources: a PDF's embedded text layer where one exists, and a vision model for
everything else. A page counts as having a usable layer at a dozen letters or more, which
filters out page furniture.

Thinking must be disabled (`chat_template_kwargs.enable_thinking: false`, and
`reasoning_effort: 'none'` for servers that accept it). Left on, the model spends its
whole token budget reasoning and the transcript gets truncated.

Two failure modes needed explicit guards, both found on real scans:

- **Table loops.** Asked for a receipt, the model emitted a markdown table and then empty
  rows for a minute and a half. Fixed by streaming the response, cutting at the first
  line repeated more than three times, and asking for plain text in the prompt.
- **Digit sheets.** A page of random digits, such as a TAN list, gets transcribed one
  token at a time and never converges. Fixed by aborting when output passes 1500
  characters with under 5% letters.

A transient empty answer on a page that clearly has text is worth one retry before
falling back, since it does happen.

## Choosing a model

See `docs/ocr-benchmark.md` for the method and numbers. The two findings worth carrying
elsewhere:

**The engine version matters more than the model at small sizes.** The same E2B weights
scored 22.9% word error on a stale llama.cpp build and 8.4% on one from master. Anything
concluded about a small vision model on an old build is probably wrong.

**Thinking is not worth it for transcription.** It moved E2B from 8.4% to 6.9% and
tripled the time. A larger model without thinking beat a smaller one with it on both
axes. Transcription is perception, not deliberation.

Also worth knowing: a sparse mixture-of-experts model decodes about as fast as a dense
model of its active-parameter count, so a 26B-A4B can be both better and faster than a
dense 4B on hardware with memory to spare.

## Background work

Extraction takes tens of seconds per page, so uploads enqueue and return. The queue lives
in SQLite so work survives a restart; jobs left `running` by a crash are requeued at boot.

Ordering falls out of the queue rather than a state machine. Extraction is enqueued
first and classification second, and with a single FIFO worker that is enough to
guarantee the model sees the extracted text. A retried job keeps its row id, so the
ordering survives failures too.

The idle timer must be `unref`'d. Otherwise it keeps Node alive, every stop takes the
full systemd timeout and ends in SIGKILL.

## Titling and tagging

Showing the model the existing tags and notebooks is what stops the vocabulary sprawling
into near-duplicates. It also creates a trap: the first run tagged everything with a
*notebook* name, because the notebook list was in the same prompt. The parser now filters
notebook names and artefact words such as "Scan" and "PDF", and the prompt asks for
subject matter with examples.

Model output needs tolerant parsing. Expect markdown fences, surrounding prose, tags as a
comma-separated string rather than an array, and trailing punctuation on titles.

## Migrations

Indexes over columns that a migration adds must be created *after* the migration runs.
Putting such an index in the base schema breaks opening every existing database, because
the column does not exist yet.

Copy a database with `sqlite3 .backup`, never `cp`. The backup checkpoints the
write-ahead log and is safe while the application is running; a plain copy can land torn.

## Platform notes

- Raw `node` needs `.ts` extensions on relative imports, but `$lib` imports must not have
  them or `svelte-check` objects.
- SvelteKit imports every server module during the build to analyse it, so the database
  handle has to be lazy. A build has no business opening or migrating a database.
- The adapter-node output is not self-contained: Vite leaves CommonJS dependencies
  external, so the deployment target needs a minimal runtime `package.json` and
  `npm install --omit=dev`.
- Behind a reverse proxy, set `PROTOCOL_HEADER` and `HOST_HEADER` rather than a fixed
  `ORIGIN`, so both the hostname and the raw address keep working.
- SvelteKit rejects cross-site multipart POSTs. Uploads work from a browser but need an
  explicit `Origin` header from `curl`. That is the CSRF guard behaving correctly.
- `llama-server` answers `/v1/models` with *both* `data` and `models` keys, and reports
  ids as absolute file paths, so matching on a configured model name fails.
- Headless Chromium blanks the whole tab when an iframe loads a PDF, which makes PDF
  views impossible to verify by screenshot.

## Testing

The server modules are covered properly. The Svelte components are not: they were
verified by driving the running app in a browser. The component test project is
configured but empty, which is the largest gap in the suite.
