#!/usr/bin/env python3
"""Compose store screenshot panels from raw simulator captures.

Each panel: brand headline (Bebas) + mono sub-line over the raw screenshot in
a rounded, hairline-bordered card that bleeds off the bottom edge. Light panels
use the app's page color; panels marked dark use the graphite band.

Run with the worker venv (it has Pillow):
  worker/.venv/bin/python scripts/make-store-screenshots.py
Raw captures are read from screenshots/ (see PANELS below); output lands in
store/screenshots/ios-6.9/ at 1290x2796.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "screenshots"
OUT = ROOT / "store" / "screenshots" / "ios-6.9"

W, H = 1290, 2796
MARGIN = 92

# Brand tokens (site/theme.css)
PAGE = "#f5f7f1"
INK = "#101411"
MUTED = "#60685f"
ACCENT = "#b6ff2e"
ACCENT_TEXT = "#2e7d32"
LINE = "#dde3da"
BAND = "#111613"
BAND_INK = "#f0f4ec"
BAND_MUTED = "#8d978b"

BEBAS = str(ROOT / "node_modules/@expo-google-fonts/bebas-neue/400Regular/BebasNeue_400Regular.ttf")
MONO = str(ROOT / "node_modules/@expo-google-fonts/ibm-plex-mono/500Medium/IBMPlexMono_500Medium.ttf")

PANELS = [
    {
        "out": "01-hero.png",
        "raw": "Simulator Screenshot - iPhone 16 Plus - 2026-07-13 at 15.19.42.png",
        "crop_top": 230,
        "crop_bottom": 1880,
        "headline": ["SEE YOUR RIDING,", "FRAME BY FRAME."],
        "sub": "Your body position drawn on every frame",
    },
    {
        "out": "02-step.png",
        "raw": "Simulator Screenshot - iPhone 16 Plus - 2026-07-15 at 16.06.38.png",
        "crop_top": 230,
        "crop_bottom": 1880,
        "headline": ["STEP THROUGH", "THE SEND"],
        "sub": "Every frame analyzed — up to 60 per second",
    },
    {
        "out": "03-trim.png",
        "raw": "Simulator Screenshot - iPhone 16 Plus - 2026-07-15 at 16.05.42.png",
        "crop_top": 230,
        "headline": ["PICK THE MOMENT"],
        "sub": "From approach through landing",
    },
    {
        "out": "04-library.png",
        "raw": "Simulator Screenshot - iPhone 16 Plus - 2026-07-15 at 16.09.48.png",
        "headline": ["YOUR LIBRARY", "OF SENDS"],
        "sub": "Private, on your phone — no account needed",
    },
    {
        "out": "05-fullscreen.png",
        "raw": "sequence_full_screen/04.png",
        "crop_top": 340,
        "crop_bottom": 2725,
        "headline": ["GO FULLSCREEN"],
        "sub": "Frame stepping and 1/4-speed slow motion",
        "dark": True,
    },
    # 06-share.png joins once the share-sheet capture exists.
]


def fit_font(path: str, text: str, max_width: int, start: int) -> ImageFont.FreeTypeFont:
    size = start
    while size > 40:
        font = ImageFont.truetype(path, size)
        if font.getlength(text) <= max_width:
            return font
        size -= 4
    return ImageFont.truetype(path, 40)


def rounded_card(img: Image.Image, radius: int, border: str) -> Image.Image:
    """Round the screenshot's corners and draw a hairline border."""
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, *img.size], radius=radius, fill=255)
    card = Image.new("RGBA", img.size)
    card.paste(img, (0, 0), mask)
    ImageDraw.Draw(card).rounded_rectangle(
        [0, 0, img.size[0] - 1, img.size[1] - 1], radius=radius, outline=border, width=3
    )
    return card


def build(panel: dict) -> None:
    dark = panel.get("dark", False)
    bg, ink, muted = (BAND, BAND_INK, BAND_MUTED) if dark else (PAGE, INK, MUTED)
    sub_color = BAND_MUTED if dark else ACCENT_TEXT

    canvas = Image.new("RGB", (W, H), bg)
    draw = ImageDraw.Draw(canvas)

    # Headline block
    y = 150
    text_width = W - 2 * MARGIN
    biggest = max(panel["headline"], key=len)
    font = fit_font(BEBAS, biggest, text_width, 190)
    for line in panel["headline"]:
        draw.text((MARGIN, y), line, font=font, fill=ink)
        y += int(font.size * 0.98)

    # Mono sub-line with the electric eyebrow square
    y += 34
    mono = fit_font(MONO, panel["sub"], text_width - 60, 42)
    sq = int(mono.size * 0.55)
    draw.rectangle([MARGIN, y + mono.size // 2 - sq // 2, MARGIN + sq, y + mono.size // 2 + sq // 2], fill=ACCENT)
    draw.text((MARGIN + sq + 26, y), panel["sub"], font=mono, fill=sub_color)
    y += mono.size + 96

    # Screenshot card: centered, bleeding off the bottom edge
    raw = Image.open(RAW / panel["raw"]).convert("RGB")
    crop_top = panel.get("crop_top", 0)
    crop_bottom = panel.get("crop_bottom", raw.height)
    if crop_top or crop_bottom != raw.height:
        raw = raw.crop((0, crop_top, raw.width, crop_bottom))
    card_w = W - 2 * (MARGIN - 12)
    card_h = int(raw.height * card_w / raw.width)
    raw = raw.resize((card_w, card_h), Image.LANCZOS)
    card = rounded_card(raw, radius=58, border="#2a2f2a" if dark else LINE)

    # Short cards float with balanced breathing room; tall ones bleed off the
    # bottom edge as before.
    free = H - y - card_h
    if free > 0:
        y += int(free * 0.42)

    # Soft shadow
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [MARGIN - 12, y + 18, MARGIN - 12 + card_w, y + 18 + card_h], radius=58,
        fill=(10, 14, 10, 90),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(30))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow)
    canvas.paste(card, (MARGIN - 12, y), card)

    OUT.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(OUT / panel["out"], optimize=True)
    print(f"{panel['out']}  <- {panel['raw']}")


if __name__ == "__main__":
    for panel in PANELS:
        build(panel)
