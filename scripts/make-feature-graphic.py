#!/usr/bin/env python3
"""Google Play feature graphic (1024x500), matching the store-panel style:
electric green gradient, Bebas wordmark + mono tagline left, the device-framed
library screenshot bleeding off the right edge.

Run: worker/.venv/bin/python scripts/make-feature-graphic.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "store" / "feature-graphic.png"

W, H = 1024, 500
INK = (17, 22, 19)

BEBAS = str(ROOT / "node_modules/@expo-google-fonts/bebas-neue/400Regular/BebasNeue_400Regular.ttf")
MONO = str(ROOT / "node_modules/@expo-google-fonts/ibm-plex-mono/500Medium/IBMPlexMono_500Medium.ttf")

# Diagonal electric gradient, like the designed screenshot panels.
top, bottom = (216, 250, 63), (174, 242, 37)
canvas = Image.new("RGB", (W, H))
for y in range(H):
    t = y / H
    row = tuple(int(a + (b - a) * t) for a, b in zip(top, bottom))
    ImageDraw.Draw(canvas).line([(0, y), (W, y)], fill=row)

draw = ImageDraw.Draw(canvas)

# Left block: mark + wordmark + tagline
mark = Image.open(ROOT / "assets/brand-mark.png").convert("RGBA").resize((96, 96), Image.LANCZOS)
canvas.paste(mark, (64, 74), mark)

bebas = ImageFont.truetype(BEBAS, 150)
draw.text((60, 168), "RIDERLENS", font=bebas, fill=INK)

mono = ImageFont.truetype(MONO, 30)
draw.text((64, 340), "SEE YOUR RIDING,", font=mono, fill=INK)
draw.text((64, 382), "FRAME BY FRAME.", font=mono, fill=INK)

# Device frame bleeding off the right/bottom edge.
phone = Image.open(ROOT / "store/device-frame-library.png").convert("RGBA")
target_h = 620
phone = phone.resize((int(phone.width * target_h / phone.height), target_h), Image.LANCZOS)
canvas.paste(phone, (W - phone.width - 56, 44), phone)

canvas.save(OUT, optimize=True)
print(OUT, canvas.size)
