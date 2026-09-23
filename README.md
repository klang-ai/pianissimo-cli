# Pianissimo CLI

Transcribe Swedish audio from your terminal with [Klang Pianissimo](https://huggingface.co/KlangAI/pianissimo-sv). Takes local files, folders, podcast feeds, YouTube channels and media URLs. Inference runs on your computer; audio is not uploaded to a transcription service.

```bash
pianissimo interview.wav
pianissimo ./recordings --recursive --format txt,srt
pianissimo 'https://www.youtube.com/@svt/videos' --limit 3 --output ./svt
pianissimo 'https://api.sr.se/api/rss/pod/itunes/3795' --limit 1
pianissimo 'https://www.svtplay.se/klipp/eDvaJEz/vem-ar-alexander-ernstberger'
```

## Install

Requires Node.js 24+, Python 3.10–3.13 (3.12 recommended), and FFmpeg with ffprobe. The model download is about 2.51 GB, plus Python dependencies and space for temporary audio. Allow at least 10 GB free for a CPU installation; CUDA needs more.

On macOS, install the prerequisites with Homebrew:

```bash
brew install node@24 python@3.12 ffmpeg uv
```

On Ubuntu/Debian, install Python and FFmpeg, and use a Node.js 24+ installation:

```bash
sudo apt update
sudo apt install python3 python3-venv ffmpeg
node --version # Must be v24 or newer; distribution packages may be older.
```

Other Linux distributions need the equivalent Python, venv and FFmpeg packages.
If installed, `uv` speeds up setup; otherwise setup uses Python's bundled pip.

Install the CLI and download the model:

```bash
npm install -g @klangai/pianissimo-cli
pianissimo setup
pianissimo doctor
pianissimo interview.wav
```

`setup` finds a supported Python on PATH, installs an isolated environment and downloads the model once. Running it again reuses the environment and model. To choose a Python interpreter, use `pianissimo setup --python /path/to/python3.12`.

Linux computers without a working NVIDIA GPU get CPU-only PyTorch, avoiding the large CUDA runtime download. Intel and AMD graphics use CPU inference. macOS keeps its standard PyTorch build with Apple Metal support. NVIDIA detection uses `nvidia-smi`; for a custom CUDA build, see [GPU and cache](#gpu-and-cache).

CI runs setup and real Swedish speech inference on Linux and macOS. CUDA, native Windows and WSL2 inference are not covered by these checks.

## Sources

| Input | What gets transcribed |
| --- | --- |
| Audio or video file | Any format FFmpeg can decode |
| Folder | Media files sorted by name; add `--recursive` for subfolders |
| RSS or Atom feed | Episodes with audio/video enclosures, in feed order |
| YouTube URL | Video, playlist or channel tab such as `/videos` |
| SVT Play or other media URL | Public media supported by [yt-dlp](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) |
| Direct audio URL | The linked recording |

For podcasts, use the feed URL. Podcast landing pages and private feeds are not supported. Media availability depends on the site and your region; example URLs may expire.

```bash
# Preview a channel without downloading audio or loading the model
pianissimo 'https://www.youtube.com/@svt/videos' --limit 3 --dry-run

# Save two podcast episodes as text and subtitles
pianissimo 'https://api.sr.se/api/rss/pod/itunes/3795' --limit 2 --format txt,srt --output ./podcasts
```

For web playlists, `--limit` counts inspected entries, including unavailable or live entries that are skipped. For folders and feeds, it counts playable sources. Use `--source feed` or `--source web` if a URL is ambiguous.

## Output

Transcripts are saved in `./transcripts`. Change the destination with `--output`. Available formats are `txt` (default), `md`, `json`, `srt` and `vtt`. A JSON file with full text, word timestamps, source and model metadata is always saved alongside the requested formats.

`--format` also selects stdout. With several formats, the first is printed and all are saved:

```bash
pianissimo interview.wav --format srt > interview.srt
pianissimo interview.wav --format vtt,txt --output ./exports
pianissimo ./recordings --format json > transcripts.ndjson
```

JSON stdout contains one complete transcript object per line. Use a single source when redirecting SRT or VTT into one subtitle file. Progress and errors go to stderr; `--quiet` hides progress.

For scripts that need file paths, per-source errors and a final summary, use `--json`. This selects an NDJSON event stream instead of transcript-only stdout; `--format` still controls saved files.

```bash
pianissimo ./recordings --recursive --format txt,srt --json > results.ndjson
pianissimo doctor --json
```

Discovery or fatal errors may end the event stream before a summary. Exit codes: `0` for success (including a closed downstream pipe), `1` for invalid arguments or a fatal error, `2` for a completed run with failed sources, and `130` for interruption.

Subtitles use recognition timestamps. Speaker diarization, forced alignment and automatic language detection are not included.

## GPU and cache

The default `--device auto` selects CUDA, then Apple Metal/MPS, then CPU, depending on availability. An Apple Silicon Mac uses its GPU automatically when available. To compare devices without reusing transcripts:

```bash
pianissimo interview.wav --device mps --force
pianissimo interview.wav --device cpu --force
```

`--force` bypasses the transcript cache, keeping downloaded model weights. Model loading happens once per command and can dominate short recordings, so a GPU is not always faster end to end. MPS allows unsupported operators to run on CPU. An explicitly requested device fails if unavailable.

Completed transcripts are reused on later runs. Changing export formats or the output folder does not require new inference. Changed local files or inference settings get a new cache entry. Use `--force` when remote audio changes under the same source ID.

Ctrl+C stops the run and removes temporary audio. Completed transcripts remain saved; an interrupted file starts again next time. Individual source failures do not stop the remaining sources; discovery and fatal worker errors do.

Local files work offline after setup:

```bash
HF_HUB_OFFLINE=1 pianissimo interview.wav
```

## Storage

The installed CLI keeps its Python environment, model, transcript cache and logs in the OS application data directory:

| OS | Default home |
| --- | --- |
| macOS | `~/Library/Application Support/pianissimo` |
| Linux | `$XDG_DATA_HOME/pianissimo`, or `~/.local/share/pianissimo` |
| Windows | `%LOCALAPPDATA%\pianissimo\Data` |

Set `PIANISSIMO_HOME` to choose another directory. `pianissimo doctor` prints the active paths and checks dependencies. One run uses a home directory at a time.

Temporary audio is removed when the command ends. `--keep-audio` retains it and prints its location. After a forced kill, temporary files may remain. Worker logs are kept for troubleshooting.

To reuse a model downloaded during development:

```bash
pianissimo setup --from /absolute/path/to/pianissimo-cli/.pianissimo
```

For a custom Python/CUDA environment, install `worker/requirements.txt` with the appropriate PyTorch build and set `PIANISSIMO_PYTHON` to its interpreter. `setup` will not modify that environment. `PIANISSIMO_YTDLP` selects a custom downloader.

## Development

```bash
git clone https://github.com/klang-ai/pianissimo-cli.git
cd pianissimo-cli
npm ci
npm run dev -- setup
npm run dev -- interview.wav --format srt
npm run check
npm run test:package
npm run test:media
```

`npm run dev` uses the checkout's `.pianissimo/` directory. Keep the `--` separator so npm passes flags to the CLI. When piping output, use `npm run --silent dev -- interview.wav --format json`.

To install a checkout globally, run `npm run build && npm install -g .`.

`test:media` needs yt-dlp and FFmpeg; `setup` installs yt-dlp. The checks above do not download the model. To verify setup, actual speech recognition, word timestamps, subtitles and offline cache reuse with the development environment:

```bash
npm run dev -- setup
PIANISSIMO_HOME="$PWD/.pianissimo" npm run test:inference
```

Run `pianissimo --help` for everyday options and `pianissimo --help-all` for advanced flags.

## License

The CLI source code is licensed under the [MIT License](LICENSE).

The [Pianissimo model](https://huggingface.co/KlangAI/pianissimo-sv) is developed by Klang and licensed separately under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Model weights are downloaded unchanged and are not bundled with the CLI. See [NOTICE](NOTICE) for model attribution. Dependencies retain their own licenses.
