# Swedish speech fixture

`swedish.wav` is original synthetic speech generated with eSpeak NG 1.51, then
converted to mono 16 kHz PCM with FFmpeg. It contains no recorded personal data.

Text: “Hej! Det här är ett test av svensk taligenkänning. Idag skiner solen och vi tar en promenad.”

To reproduce:

```bash
espeak-ng -v sv -s 140 -w speech.wav 'Hej! Det här är ett test av svensk taligenkänning. Idag skiner solen och vi tar en promenad.'
ffmpeg -i speech.wav -ar 16000 -ac 1 swedish.wav
```

The inference smoke test checks for recognized speech and word timestamps, not
an exact transcript or a recognition-quality benchmark. This fixture is not
included in the published npm package.
