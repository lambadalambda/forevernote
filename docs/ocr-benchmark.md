# OCR engine comparison

Measured 2026-09-20. Reproduce with:

```sh
python3 scripts/bench_fixtures.py /tmp/fixtures --pages 10
node scripts/bench-ocr.ts --fixtures /tmp/fixtures            # local Lemonade
FOREVERNOTE_LLM_URL=http://<host>:8081/v1 node scripts/bench-ocr.ts --fixtures /tmp/fixtures --no-vision
```

## Method

A scanned archive rarely offers a trustworthy reference. A scanned PDF's embedded
text layer is itself OCR, often bad, and born-digital pages are scarce. So the
fixtures typeset German passages taken from the notes and degrade them like a
scan: rotation, resampling, sensor noise, blur, JPEG artifacts. The source text is
then exact ground truth. Ten pages, about 111 words each, half "good" scans and
half "rough" (lower resolution, blurrier, heavier compression).

- **WER** word error rate, order-sensitive. Lower is better.
- **F1** multiset word overlap, order-insensitive. Fair to engines that read
  tables in a different order. Higher is better.

Caveat: the passages come from text the largest model produced, so it may enjoy a small
familiarity advantage. The gaps between engines are far larger than that effect.

## Results — AMD Radeon 780M via Vulkan, llama.cpp 3cf03257f

| engine                 | WER % | good | rough | F1 % | s/page |
| ---------------------- | ----- | ---- | ----- | ---- | ------ |
| gemma-4-26B-A4B (MoE)  | 3.5   | 1.4  | 5.6   | 97.0 | 29.8   |
| gemma-4-E4B            | 4.6   | 2.7  | 6.6   | 95.8 | 26.6   |
| gemma-4-E2B + thinking | 6.9   | 3.4  | 10.4  | 94.8 | 42.4   |
| gemma-4-E2B            | 8.4   | 3.8  | 12.9  | 93.6 | 13.8   |
| gemma-4-E2B, CPU only  | 8.7   | 4.4  | 12.9  | 93.2 | 21.4   |
| Apple Vision, fast     | 52.2  | 22.0 | 82.4  | 55.6 | 0.2    |

## Results — Apple M-series, Lemonade 11.9.0 with its bundled llama.cpp

| engine          | WER % | s/page warm |
| --------------- | ----- | ----------- |
| gemma-4-26B-A4B | 3.8   | 9.9         |
| gemma-4-E4B     | 7.0   | 13.8        |
| gemma-4-E2B     | 22.9  | 5.1         |

## What this means

**The engine version matters more than the model at small sizes.** E2B scores
22.9 % on Lemonade's bundled llama.cpp and 8.4 % on a build from master with
identical weights. A June build reproduced the bad number before it was updated. Anything concluded about a small vision model on a stale llama.cpp
is probably wrong.

**E4B is the quality sweet spot.** 4.6 % against the 26B's 3.5 %, from 5 GB
instead of 17 GB, and marginally faster on the iGPU.

**Thinking is not worth it.** It moves E2B from 8.4 % to 6.9 % but triples the
time. E4B without thinking beats E2B with thinking on both axes, so the right
move is a bigger model rather than more reasoning. Transcription is perception,
not deliberation.

**The 26B can be the fastest option, not the slowest.** It is a sparse mixture of
experts with roughly 4B active parameters, so it decodes like a small model
while knowing much more. On a machine with memory to spare it beat dense E4B on both speed and quality.
On the 780M integrated GPU everything converges to 25-30 s/page.

**CPU-only works.** E2B lost almost nothing without the GPU, 8.7 % against 8.4 %, at
21 s/page. Extraction does not need a GPU, but it does need a few GB of RAM for the
weights.

**Apple Vision is a fallback only.** It holds up on clean scans (22 %) and
collapses on rough ones (82 %), which is what most real scans look like.

## Failure modes

The models fail differently from classical OCR, and the difference matters for
an archive. Classical OCR produces visible garbage, turning a company name into
`Mu$terflrma Gmb1-1 Po5ttach`. The
language models produce fluent, plausible substitutions instead — E2B turned
`Mahngebühr` into a different but sensible fee word. Garbage is obvious on
sight; a confident wrong word is not. Larger models do this less.
