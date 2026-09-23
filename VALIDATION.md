# Validation — 0.2.1

Verified locally on 2026-09-23. These are integration and smoke tests, not a representative speech accuracy benchmark.

## Environment

- Apple M5 Pro, 24 GB RAM, macOS arm64
- Node.js 24.13.0; Python 3.12.7
- NeMo 3.0.0; PyTorch 2.14.0
- FFmpeg/FFprobe 8.0.1; managed yt-dlp 2026.08.19
- Pianissimo revision `8f1f6d8f8bd7482a5ea1d2bfaf6ef5be61597138`
- `uv pip check` reports all 141 installed Python packages compatible.

## Automated checks

`npm run check` passes type checking, 38 TypeScript tests, eight Python tests and production compilation. The build removes stale compiled files before compiling, including the deleted SQLite/job modules.

Coverage includes:

- Simplified CLI, validation, machine-readable dry runs and no state writes during dry runs.
- Stdout follows TXT/Markdown/JSON/SRT/VTT selection; multiple formats use the first; JSON collections stream transcript objects; explicit `--json` retains events and summary. These run against seeded cache entries with Python unavailable.
- The actual SVT YouTube channel command with `--limit 3 --format json` returned three parseable transcript objects from cache on stdout.
- Local hashing, recursive traversal and symlink loops.
- RSS/Atom parsing, relative URLs, duplicate GUIDs, stable identity across signed URL changes, malformed/deep XML, CDATA descriptions, unsafe URLs and response size limits.
- Bounded prefetch, cancellation, subprocess cleanup and literal argument passing without a shell.
- Per-source failures, completed-file cache, interrupted-file restart, `--force` and export retries without inference.
- Cache corruption, settings validation and reuse of existing canonical exports.
- Model cache migration that resolves Hugging Face symlinks to independent hardlinks.
- Compatibility-command option routing, fatal worker fail-fast, process-group termination with TERM-resistant grandchildren, inherited Atom bases and UTF-8 filename budgets.
- Generic/HTML5 URL identities, matching audio selection, explicit missing-resource errors and preserved referers.
- Worker reuse, startup failures, malformed protocol messages, resolved device reporting and cancellation during model loading.
- Subtitle timing/grouping, Unicode and safe export filenames.
- Near-boundary audio padding without a tiny extra inference call, and rejecting files changed during preparation.
- Real FFmpeg stereo 44.1 kHz → mono 16 kHz conversion and slicing.
- Python automatic/explicit device selection and cache-first model resolution.

`npm run test:package` packs the actual distributable, checks its file manifest, installs only production dependencies into a temporary prefix and runs its version, help and JSON file-discovery commands. The manifest rejects bundled state, weights, Python bytecode and obsolete job modules. CI is configured to run checks, real media integration and packaging on Ubuntu and macOS; the remote workflow has not been run from this checkout.

## Review verification (0.2.1)

Two independent review agents completed separate passes. Corrections and verification are recorded in [REVIEW.md](REVIEW.md).

- `npm run test:media` uses real yt-dlp 2026.08.19 and FFmpeg against a local HTML5 page. Two different resources named `audio.wav` require the page's referer; both were discovered and downloaded independently, with correct 0.5/0.9-second durations and zero HTTP 403 responses.
- Real MPS inference was repeated offline after the subprocess changes. The 14.95-second Swedish sample produced 35 words; startup and inference took 17.41 seconds. The existing model checkpoint was reused.
- The isolated production-package test passed after the process and CLI changes.

## Earlier 0.2.0 inference

| Input | Device | Audio duration | Words | Model startup + inference |
| --- | --- | ---: | ---: | ---: |
| Swedish synthetic speech, local AIFF | CPU | 14.95 s | 35 | 19.61 s |
| Sveriges Radio, Ekot 17:45 on 2026-09-23 | MPS, Apple M5 Pro | 1,200.00 s | 2,867 | 28.30 s |
| SVT Play, “Vem är Alexander Ernstberger?” | MPS, Apple M5 Pro | 147.14 s | 357 | 16.72 s |

The podcast and SVT tests exercised actual discovery, download, FFmpeg normalization, multiple inference chunks, persistent model caching and TXT/JSON/SRT exports. All inspected word timestamps were ordered and remained within the source duration. The processing column excludes initial source discovery, media download and normalization; it includes worker/model startup and chunk slicing. These numbers are not end-to-end throughput claims.

Sources tested:

- Podcast RSS: `https://api.sr.se/api/rss/pod/itunes/3795`
- SVT Play: `https://www.svtplay.se/klipp/eDvaJEz/vem-ar-alexander-ernstberger`
- YouTube channel discovery: `https://www.youtube.com/@svt/videos`, limited to two entries

The local CPU test wrote TXT/JSON/SRT/VTT. Repeating it with a different destination and Markdown export succeeded with `PIANISSIMO_PYTHON=/does-not-exist` and `HF_HUB_OFFLINE=1`: no Python process or model download was needed. No recognition accuracy score was measured; synthetic speech contained the substitution “sades” → “sas”.

SVT source availability was tested explicitly: a program page without available episodes returned a clear no-media error, and an expired clip returned HTTP 404. A current clip then completed the full pipeline. This is why the CLI accepts supported media URLs without promising that every page is playable.

The 20-minute podcast initially included a 1 ms padded tail after ten 120-second chunks. The implementation now keeps this tail in the last chunk instead of invoking inference on an extra tiny chunk; a regression test covers it.

## Cache, installation and GPU details

Weights are resolved locally first. CPU and GPU runs above used the existing checkpoint on disk, including runs with `HF_HUB_OFFLINE=1`. Transcript caching and model caching are independent. Cached transcripts retain the runtime of the original inference; use `--force` for device comparisons.

Metal is hidden from the execution sandbox on the test machine. GPU checks ran with access to Metal. The worker verifies model parameter placement before reporting `mps (Apple M5 Pro)`. Individual unsupported operations may use PyTorch's enabled MPS fallback. Explicit unavailable GPU requests fail; `auto` selects the best available backend.

An earlier warm inference comparison on a 44.84-second synthetic recording, using the same worker and model revision:

| Device | Startup + first transcription | Mean of two warm runs |
| --- | ---: | ---: |
| CPU | 16.26 s | 1.443 s |
| MPS, Apple M5 Pro | 14.99 s | 0.437 s |

Both devices returned identical text and 105 words in that small sample. Startup dominates short CLI invocations. This is not a general GPU speedup guarantee.

Earlier complete YouTube inference on SVT trailer `YMY3ht57ClU` processed approximately 84 seconds of real speech/music through download, three inference chunks and subtitle exports. The new shared source adapter was rechecked against the channel in 0.2.0.

Smoke inputs, exports and logs remain under `.pianissimo/smoke/` and `.pianissimo/`; they are excluded from the npm package. Old job databases are left intact but are no longer read or written.

## Not verified or not included

- CUDA inference, Linux inference installation, native Windows and WSL2 execution.
- A fresh Python dependency installation on every supported platform. The existing macOS environment and its installer rerun are tested locally.
- Multi-hour recordings, thousands of playlist entries and long-running load tests.
- Authenticated, private, DRM-protected or region-restricted media; podcast landing-page autodiscovery.
- Diarization, GPU batching, remote workers, watch mode and background jobs.

The CLI has not been published to npm. A distribution license for the CLI source has not been selected; model attribution is included in NOTICE.
