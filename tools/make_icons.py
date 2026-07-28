#!/usr/bin/env python3
"""Generate the extension icon set.

The mark is an isometric cube (a 3D asset) sitting inside a rounded tile, drawn
at 8x and downsampled so the edges stay clean at 16px.
"""
from PIL import Image, ImageDraw
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
SIZES = (16, 48, 128)
SS = 8  # supersample factor

BG_TOP = (28, 34, 48)       # deep slate
BG_BOTTOM = (11, 13, 18)    # near black
INK = (7, 9, 13)

# Lit from the upper left: bright accent on top, cooler shaded sides.
TOP_FACE = (197, 249, 85, 255)
LEFT_FACE = (124, 173, 60, 255)
RIGHT_FACE = (86, 124, 148, 255)


def gradient(size, top, bottom):
    img = Image.new("RGB", (1, size), top)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        d.point((0, y), fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return img.resize((size, size), Image.NEAREST)


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius, fill=255)
    return mask


def cube(size):
    """Isometric cube centred in a `size` box, on a transparent layer."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    cx = size / 2
    w = size * 0.30          # half-width
    h = size * 0.17          # half-height of the top rhombus
    body = size * 0.26       # vertical extent of the side faces
    top_y = size * 0.26

    apex = (cx, top_y)
    right = (cx + w, top_y + h)
    bottom = (cx, top_y + 2 * h)
    left = (cx - w, top_y + h)

    d.polygon([apex, right, bottom, left], fill=TOP_FACE)
    d.polygon([left, bottom, (cx, bottom[1] + body), (cx - w, right[1] + body)], fill=LEFT_FACE)
    d.polygon([bottom, right, (cx + w, right[1] + body), (cx, bottom[1] + body)], fill=RIGHT_FACE)

    # Seam lines give the faces definition when scaled down.
    for a, b in ((bottom, apex), (bottom, left), (bottom, right),
                 (bottom, (cx, bottom[1] + body))):
        d.line([a, b], fill=(*INK, 70), width=max(1, round(size * 0.012)))
    return layer


def build(px):
    big = px * SS
    tile = gradient(big, BG_TOP, BG_BOTTOM).convert("RGBA")
    tile.putalpha(rounded_mask(big, round(big * 0.22)))
    tile.alpha_composite(cube(big))
    return tile.resize((px, px), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for px in SIZES:
        path = OUT / f"icon{px}.png"
        build(px).save(path, "PNG", optimize=True)
        print(f"wrote {path} ({path.stat().st_size} bytes)")

    # 440x280 small promo tile for the Chrome Web Store listing.
    promo = Image.new("RGBA", (440 * 2, 280 * 2), (11, 13, 18, 255))
    mark = build(150 * 2)
    promo.alpha_composite(mark, (48 * 2, (280 - 150) // 2 * 2))
    promo.convert("RGB").resize((440, 280), Image.LANCZOS).save(
        OUT.parent.parent / "docs" / "promo-440x280.png", "PNG", optimize=True
    )
    print("wrote docs/promo-440x280.png")


if __name__ == "__main__":
    main()
