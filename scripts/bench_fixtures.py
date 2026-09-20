#!/usr/bin/env python3
"""Builds scan-like OCR benchmark pages with exact ground truth.

The collection has essentially no born-digital PDFs, so real pages have no
trustworthy reference: their embedded text layer is itself scanner OCR. Instead
we take real German passages out of the notes, typeset them, and degrade the
result the way a flatbed scan does (rotation, resampling, sensor noise, mild
blur, JPEG artifacts). The source text is then exact ground truth.

Usage: python3 scripts/bench_fixtures.py OUTDIR [--pages N] [--db PATH]
Writes page-N.jpg and page-N.txt pairs, plus a clean page-N-clean.png for reference.
"""
import argparse
import os
import random
import re
import sqlite3
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = [
    "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Georgia.ttf",
]
WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)


def passages(db_path, count):
    """Contiguous runs of real document lines, one per note, long enough to score."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    rows = con.execute(
        "SELECT ocr_text FROM resources "
        "WHERE ocr_source = 'llm' AND length(ocr_text) > 1200 "
        "GROUP BY note_id ORDER BY id"
    ).fetchall()
    con.close()

    out = []
    for (text,) in rows:
        if len(out) >= count:
            break
        lines = [l.strip() for l in text.split("\n")]
        lines = [l for l in lines if len(l) > 15 and re.search(r"\w", l)]
        if len(lines) < 10:
            continue
        chunk = "\n".join(lines[:16])
        if len(WORD_RE.findall(chunk)) >= 90:
            out.append(chunk)
    return out


def wrap(draw, text, font, max_width):
    lines = []
    for para in text.split("\n"):
        if not para:
            lines.append("")
            continue
        words, line = para.split(" "), ""
        for word in words:
            trial = f"{line} {word}".strip()
            if draw.textlength(trial, font=font) <= max_width or not line:
                line = trial
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return lines


def render(text, font_path, size=30, width=1500, margin=90):
    font = ImageFont.truetype(font_path, size)
    probe = ImageDraw.Draw(Image.new("L", (10, 10), 255))
    lines = wrap(probe, text, font, width - 2 * margin)
    leading = int(size * 1.55)
    img = Image.new("L", (width, margin * 2 + leading * len(lines)), 255)
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        draw.text((margin, margin + i * leading), line, font=font, fill=15)
    return img


# Two tiers, because the real collection has both. "good" is a clean flatbed scan;
# "rough" is a phone snap or a fax-grade copy, where small models tend to break down.
TIERS = {
    "good": dict(rot=0.5, scale=0.85, blur=(0.35, 0.6), noise=9, quality=78),
    "rough": dict(rot=1.4, scale=0.55, blur=(0.7, 1.0), noise=20, quality=45),
}


def degrade(img, rng, tier):
    """Rotation, resample, sensor noise, lens blur and JPEG artifacts."""
    t = TIERS[tier]
    img = img.rotate(rng.uniform(-t["rot"], t["rot"]), resample=Image.BICUBIC, expand=True, fillcolor=255)
    img = img.resize((int(img.width * t["scale"]), int(img.height * t["scale"])), Image.LANCZOS)
    img = img.filter(ImageFilter.GaussianBlur(rng.uniform(*t["blur"])))
    pixels = img.load()
    for y in range(img.height):
        for x in range(0, img.width, 2):  # every other pixel: enough grain, much faster
            v = pixels[x, y] + int(rng.gauss(0, t["noise"]))
            pixels[x, y] = 0 if v < 0 else 255 if v > 255 else v
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("outdir")
    ap.add_argument("--pages", type=int, default=10)
    ap.add_argument("--db", default="data/forevernote.db")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    rng = random.Random(args.seed)
    texts = passages(args.db, args.pages)
    if not texts:
        sys.exit("no source passages found; run npm run ocr first")

    for i, text in enumerate(texts):
        tier = "good" if i % 2 == 0 else "rough"
        clean = render(text, FONTS[i % len(FONTS)])
        scan = degrade(clean, rng, tier)
        scan.save(os.path.join(args.outdir, f"page-{i}-{tier}.jpg"), quality=TIERS[tier]["quality"])
        with open(os.path.join(args.outdir, f"page-{i}-{tier}.txt"), "w") as fh:
            fh.write(text)
        print(f"page-{i}-{tier}.jpg  {scan.width}x{scan.height}  {len(WORD_RE.findall(text))} words")
    print(f"\n{len(texts)} pages in {args.outdir}")


if __name__ == "__main__":
    main()
