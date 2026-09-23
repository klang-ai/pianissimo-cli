# Independent review — 0.2.1

Two separate AI subagents reviewed the code independently as senior software reviewers on 2026-09-23. One focused on architecture, command behavior and packaging; the other focused on reliability, source handling and process/data lifecycles. They did not edit the implementation. The primary agent reproduced and corrected the findings, then requested fresh review passes.

## Findings and fixes

| Area | Defect | Correction and evidence |
| --- | --- | --- |
| Process lifecycle | Stopping only a direct child left descendants running, sometimes holding pipes open indefinitely. | A shared subprocess module owns POSIX process groups and escalates TERM to KILL. Tests cover orphaned descendants and descendants ignoring TERM. Windows uses taskkill /T; Windows execution remains unverified. |
| CLI options | Root parsing consumed options intended for hidden compatibility commands, so dry-run/device/format/output settings could be ignored. | Positional option parsing plus explicit inheritance. Tests exercise both aliases, options before/after commands, overrides and actual cached exports. Advanced help now uses the argument parser, so a literal filename after `--` cannot trigger help. |
| Worker failures | Permanent startup/protocol errors were treated as per-file failures; the rest of a channel kept downloading despite an unusable worker. | Typed fatal EngineError stops discovery and prepared work. Per-file inference errors remain recoverable. Tests verify a single failed engine call and bounded preparation. |
| Embedded media | Generic entries could share IDs or the same page URL, dropping clips or downloading the wrong recording. | Generic and Html5MediaEmbed sources use full media-resource identity and retain the specific resource. Same format selection during discovery and download avoids ambiguous video/audio combinations. Missing unambiguous media is an explicit error. |
| Embedded request context | Direct media downloads lost the original page's referer and failed on protected resources. | Preserve and validate the extractor's referer, with page URL fallback, and pass it to the downloader. Verified using a downloader fixture and real HTTP/yt-dlp/FFmpeg integration. |
| Atom links | Relative enclosure links ignored inherited xml:base. | Resolve document, entry and link bases with HTTP(S) validation. Tests cover nested bases and unsafe base URLs. |
| Filenames | Character-limited Unicode titles plus temporary suffixes could exceed Linux byte limits. | UTF-8 byte budget without splitting code points; short random temporary filenames in the destination directory. Tests exercise CJK, emoji and Swedish characters. |

## Iteration

The first independent passes identified six issue categories. A second pass verified those fixes and found additional embedded-media requirements: referer propagation, consistent audio format selection and collisions between equal basename IDs. A real integration test then exposed the Html5MediaEmbed extractor name, which was added to the same handling. These cases now have repeatable regression coverage.

The reliability reviewer independently reran 27 relevant tests and reported no remaining blocking findings. The architecture reviewer independently reran 26 targeted tests plus type checking and reported no remaining blocking findings. The architecture reviewer then independently reran the CLI tests after the final argument-boundary correction and confirmed that no concrete blockers remained. The final full suite passed 38 TypeScript tests and eight Python tests, followed by an isolated package installation test.

## Validation scope

- Type checking, automated Node/Python tests and production compilation.
- Isolated npm tarball installation with production dependencies and execution of the installed entrypoint.
- Real two-resource HTTP/yt-dlp/FFmpeg integration, including referer enforcement and distinct audio durations.
- Actual offline Pianissimo inference using the existing checkpoint on the Apple M5 Pro GPU.

This review does not substitute for cross-platform execution or speech accuracy evaluation. CUDA, native Windows inference and fresh Linux inference installation remain unverified. CI is configured for Ubuntu/macOS, including the real media integration test; remote CI has not been run from this workspace. No npm publication was performed.

The review was completed before Git repository initialization, so its findings refer to the reviewed 0.2.1 files rather than a pre-existing commit hash.
