# Pianissimo CLI

Swedish speech to text, directly from your terminal. Give it a file, folder, podcast RSS feed, YouTube channel or supported media URL. Powered by [Klang Pianissimo](https://huggingface.co/KlangAI/pianissimo-sv).

```bash
pianissimo interview.wav
pianissimo ./recordings --recursive --format txt,srt
pianissimo 'https://www.youtube.com/@svt/videos' --limit 5
pianissimo 'https://api.sr.se/api/rss/pod/itunes/3795' --limit 1
pianissimo 'https://www.svtplay.se/klipp/…'
```

Inference runs locally. Audio is not uploaded to an inference service. One model process handles the entire command. Completed transcripts persist between runs, with word timestamps and TXT, Markdown, JSON, SRT and WebVTT exports.

## Install

Requirements: Node.js 24+, Python 3.12 recommended, and FFmpeg with ffprobe. The model download is about 2.51 GB; allow additional disk space for Python dependencies and temporary audio.

On macOS:

```bash
brew install node@24 python@3.12 ffmpeg uv
```

From this checkout (the package has not been published to npm):

```bash
npm ci
npm run build
npm install -g .
pianissimo setup
pianissimo doctor
pianissimo interview.wav
```

`setup` creates an isolated Python environment, installs NeMo and yt-dlp, and downloads the pinned model once. It uses `uv` when available and otherwise Python's `venv` and `pip`. Running it again repairs/checks the installation and reuses the model. Use `setup --python /path/to/python3.12` to choose an interpreter.

For development:

```bash
npm ci
npm run dev -- setup
npm run dev -- ./interview.wav
```

`npm run dev` uses this checkout's `.pianissimo/`, independent of the working directory. Use `npm run --silent dev -- …` when piping stdout.

On Linux, install Python and its venv package, Node 24+ and FFmpeg using your package manager. For Windows inference, use WSL2. Native Windows storage paths are defined, but native NeMo installation has not been verified. See [VALIDATION.md](VALIDATION.md) for the tested platforms and remaining limits.

## Storage

An installed CLI stores its environment, model and cache in the OS application data directory:

| OS | Default home |
| --- | --- |
| macOS | `~/Library/Application Support/pianissimo` |
| Linux | `$XDG_DATA_HOME/pianissimo`, or `~/.local/share/pianissimo` |
| Windows | `%LOCALAPPDATA%\pianissimo\Data` |

`PIANISSIMO_HOME` overrides the home directory. `doctor` prints the effective path. WSL uses the Linux path. Paths follow [env-paths](https://github.com/sindresorhus/env-paths).

```text
<home>/
  venv/                 Python environment and downloader
  models/               Hugging Face model cache
  cache/transcripts/    Completed transcripts, one JSON file per cache key
  logs/                 Inference worker diagnostics
```

Exports go to `./transcripts` relative to the current working directory. Set `--output ./archive` to change it. Temporary downloads and normalized audio use the OS temporary directory and are removed when the run ends. `--keep-audio` retains them and prints their location. After a forced kill, temporary files may remain until cleaned by the OS. Worker logs are retained for troubleshooting; they can be deleted when no run is active.

To reuse a development model when setting up the installed command:

```bash
pianissimo setup --from /absolute/path/to/pianissimo-cli/.pianissimo
```

Complete model snapshots are imported with hardlinks where possible, otherwise copied atomically. Existing installations are left intact. Python environments are rebuilt because they are not relocatable. The legacy `~/.pianissimo` model cache is also detected automatically. No job database is imported; existing canonical JSON exports can serve as cache entries when using the same output directory and settings.

## Sources

The input determines the source adapter. You do not need a separate command for each service.

| Input | Behavior |
| --- | --- |
| File | Any audio/video format FFmpeg can decode |
| Directory | Known media extensions, sorted by name; `--recursive` includes subfolders |
| Podcast RSS/Atom URL | Episodes with audio/video enclosures, in feed order |
| YouTube URL | Video, playlist or channel tab exposed by yt-dlp |
| SVT Play / other media URL | Public media supported by the installed yt-dlp extractor |
| Direct audio URL | Download and transcribe through yt-dlp |

For podcasts, provide the RSS/Atom feed URL. Arbitrary podcast landing pages and private subscription authentication are not included. Feed GUIDs form stable episode identities, so rotating download tokens do not invalidate transcripts. Feeds without GUIDs use the enclosure URL. Relative Atom links inherit `xml:base` from their document, entry and link. RSS/Atom documents are capped at 16 MiB and reject custom XML entities.

For YouTube, `/videos`, `/shorts` and `/streams` select a channel collection. Live/upcoming entries are skipped. `--limit` caps inspected web playlist entries, including unavailable or skipped entries; on local folders and feeds it caps playable sources. A changed remote recording with the same provider ID requires `--force` to refresh its transcript. Generic/HTML5 pages identify each embedded recording by its full media URL and retain its referer when downloading. Rotating media URLs can cause cache misses on these pages. Public URLs may expire or be unavailable in your region. [yt-dlp support](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) depends on each site's current behavior; support does not imply every URL on a site is playable.

```bash
# Preview sources without downloading audio or loading the model
pianissimo 'https://www.youtube.com/@svt/videos' --limit 5 --dry-run

# Set a destination and export formats
pianissimo 'https://api.sr.se/api/rss/pod/itunes/3795' --limit 2 --output ./podcasts --format txt,srt

# Resolve ambiguous URLs explicitly
pianissimo 'https://example.com/feed' --source feed
pianissimo 'https://example.com/watch/123' --source web
```

Directory traversal skips nested symlinks. Explicit file symlinks are accepted. Filenames combine a readable title, a source identifier hash and a settings hash. Canonical JSON is always saved alongside the selected formats; it contains the full text, word timestamps, source, pinned model revision and runtime metadata.

## Cache and interruptions

Run the command again to discover new items and reuse completed transcripts. A cache hit recreates the requested exports without downloading audio or starting Python. Export format and destination do not affect inference cache identity. File content, model revision, device setting and chunk length do.

```bash
# Real CPU inference, bypassing transcript cache
pianissimo recording.wav --device cpu --force

# Re-export previously completed work as subtitles
pianissimo recording.wav --format srt,vtt
```

`--force` bypasses the transcript cache. It does **not** redownload model weights. Weights are looked up locally first, and the same file is reused across CPU/GPU runs. Loading those weights into RAM or GPU memory happens once per CLI invocation; status messages distinguish disk loading from a download.

Ctrl+C terminates active subprocesses and cleans temporary audio. Completed files remain saved. An interrupted file starts from the beginning next time. There are no job IDs, background services, queues on disk or chunk checkpoints. One run uses a home directory at a time; after a hard crash, its lock becomes recoverable after 30 seconds.

A failed episode does not stop the remaining sources. Completed inference is cached before export, so an export failure can be retried without rerunning the model. Discovery failures and permanent inference-worker failures stop the command and pending downloads while retaining completed transcripts.

## GPU and offline use

`--device auto` selects CUDA, then Apple Metal/MPS, then CPU, based on PyTorch availability. On an Apple Silicon Mac, the regular command uses the GPU when available:

```bash
pianissimo recording.wav
pianissimo recording.wav --device mps --force
pianissimo recording.wav --device cpu --force
pianissimo doctor

# Local files work offline after setup
HF_HUB_OFFLINE=1 pianissimo recording.wav
```

Explicit GPU requests fail when unavailable. The worker checks that model parameters are on the selected device. JSON transcripts include the actual device and runtime versions; cached results retain the original runtime.

MPS enables `PYTORCH_ENABLE_MPS_FALLBACK=1` before importing PyTorch, following [NeMo's Apple GPU guidance](https://docs.nvidia.com/nemo-framework/user-guide/25.02/nemotoolkit/asr/results.html#inference-on-apple-m-series-gpu). Unsupported individual operators may run on CPU. Set it to `0` to require strict operator support. Some sandboxes hide Metal even on a compatible Mac; run from a normal terminal in that case. Model startup can dominate short recordings, so GPU inference is not necessarily faster end to end.

For a custom NeMo/CUDA environment, install the appropriate PyTorch build and `worker/requirements.txt`, then set `PIANISSIMO_PYTHON` to its Python executable. Managed `setup` refuses to modify that custom environment. `PIANISSIMO_YTDLP` selects a different recent downloader executable. Otherwise, the CLI prefers its managed downloader over system installations.

## Scripting

`--format` controls both saved files and stdout. The default is plain text. With multiple formats, the first goes to stdout and all requested formats are saved. For example, `--format srt,txt` prints SRT and saves both SRT and TXT (plus canonical JSON).

```bash
pianissimo recording.wav --format srt > subtitles.srt
pianissimo recording.wav --format vtt > subtitles.vtt
pianissimo ./recordings --format json > transcripts.ndjson
```

JSON output contains one complete transcript object per line, so collections stream without buffering. It has the same fields as the saved JSON files. SRT and VTT are rendered separately for each source; use a single source when redirecting stdout to one subtitle file. Progress and errors go to stderr. `--quiet` hides progress and retains errors.

`--json` selects the event stream for scripts and takes precedence over `--format` on stdout. It includes file paths, per-source failures and a final summary; `--format` still controls the saved files:

```bash
pianissimo ./recordings --recursive --json > results.ndjson
pianissimo doctor --json
```

```json
{"type":"transcript","cached":false,"files":["..."],"transcript":{"schemaVersion":1,"text":"...","words":[]}}
{"type":"error","source":{"id":"..."},"error":"..."}
{"type":"summary","status":"partial","completed":1,"failed":1,"cached":0}
```

The example abbreviates transcript/source metadata. Discovery and fatal errors go to stderr and may end the stream before a summary. A JSON dry run emits one `source` record per entry and a final `plan` record with `count`. Dry runs do not create the application home or load model dependencies; web discovery still requires yt-dlp and a network connection.

| Exit code | Meaning |
| --- | --- |
| 0 | Completed, help/version displayed, or downstream pipe closed |
| 1 | Invalid arguments, setup, discovery or fatal error |
| 2 | Run completed with one or more failed sources |
| 130 | Interrupted |

The only named commands are `setup` and `doctor`. Previous `transcribe` and `youtube` invocations remain hidden compatibility aliases. `--help-all` shows advanced flags: `--source`, `--revision`, `--chunk-seconds`, `--downloads` and `--keep-audio`.

## Internals and extension

Source adapters emit the same `Source` structure: stable ID, title, provenance URL/path, fingerprint and optional media URL. The pipeline consumes an async iterator, prepares a bounded number of inputs ahead (default two), and runs one persistent model process. Extending source discovery does not require changing inference, caching or exports. URL collections stream from yt-dlp; feeds are size bounded and directories are listed one folder at a time. Deduplication stores source IDs for the current remote collection.

Audio is normalized to 16 kHz mono PCM. Inference uses 120-second chunks with one second of extra context on each side. Word midpoints determine boundary ownership and timestamps are clipped to the owning interval. This bounds model input but does not guarantee identical recognition to a single pass. Temporary disk use scales with the lengths of the current and prefetched recordings.

The model revision is pinned to `8f1f6d8f8bd7482a5ea1d2bfaf6ef5be61597138`. `--revision` accepts a full immutable commit SHA. Subtitles use recognition timestamps and sentence/pause/line grouping. Speaker diarization, forced alignment and automatic language detection are not included; Pianissimo is a Swedish model.

| Area | Files |
| --- | --- |
| Commands and validation | `src/cli.ts` |
| Local, feed and web discovery | `src/sources.ts`, `src/feeds.ts`, `src/stream.ts` |
| Bounded preparation and foreground execution | `src/pipeline.ts` |
| Transcript cache and model import | `src/cache.ts`, `src/state.ts` |
| Python process and inference | `src/engine.ts`, `worker/` |
| Audio conversion and exports | `src/media.ts`, `src/export.ts` |

```bash
npm run check
npm run test:package
npm run test:media
node --import tsx scripts/benchmark-devices.ts ./short-recording.wav
```

Tests use deterministic engines without model downloads, plus real FFmpeg when available. The benchmark script uses the development environment and compares warm CPU/MPS inference on a short recording. The media integration test uses real yt-dlp and FFmpeg against a local HTTP fixture with two referer-protected audio files. See [VALIDATION.md](VALIDATION.md) for actual model and source smoke tests and [REVIEW.md](REVIEW.md) for the independent review.

## Attribution

Pianissimo is developed by Klang and released under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Model weights are downloaded unchanged and are not bundled in the npm package. See [NOTICE](NOTICE). A distribution license for the CLI source has not yet been selected.
