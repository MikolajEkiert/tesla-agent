"""Generates all app/PWA icon assets from the design tokens in src/theme.ts.
Run: python3 scripts/gen_icons.py  (from mobile/, needs Pillow)

Not part of the build pipeline — a one-off (re-run only if the icon design
changes) whose outputs are committed as regular asset files.
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw

BG = (12, 14, 18, 255)  # #0C0E12
BRAND = (111, 140, 255, 255)  # #6F8CFF
WHITE = (255, 255, 255, 255)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
PUBLIC_ICONS = os.path.join(ROOT, "public", "icons")
PUBLIC = os.path.join(ROOT, "public")

# Bolt glyph as a fraction of a unit square (0..1), a simple flat zigzag —
# reads clearly at small sizes, ties "Amp" to its literal meaning without
# reaching for a generic AI-sparkle icon.
BOLT_UNIT = [
    (0.56, 0.03),
    (0.20, 0.56),
    (0.44, 0.56),
    (0.34, 0.97),
    (0.82, 0.40),
    (0.53, 0.40),
]


def bolt_points(size: int, scale: float = 1.0, offset: tuple[float, float] = (0, 0)) -> list[tuple[float, float]]:
    cx, cy = size / 2, size / 2
    pts = []
    for ux, uy in BOLT_UNIT:
        # unit square is centered at (0.5, 0.5); scale around center
        x = cx + (ux - 0.5) * size * scale + offset[0]
        y = cy + (uy - 0.5) * size * scale + offset[1]
        pts.append((x, y))
    return pts


def flat_icon(size: int, bg: tuple[int, int, int, int] | None, fg: tuple[int, int, int, int], scale: float = 0.72) -> Image.Image:
    img = Image.new("RGBA", (size, size), bg if bg else (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.polygon(bolt_points(size, scale=scale), fill=fg)
    return img


def save(img: Image.Image, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.convert("RGBA").save(path)
    print("wrote", os.path.relpath(path, ROOT))


def main() -> None:
    # Main app icon (iOS + generic) — full bleed, opaque, no transparency.
    save(flat_icon(1024, BG, BRAND, scale=0.62), os.path.join(ASSETS, "icon.png"))

    # Splash screen glyph — transparent, shown centered on Expo's splash bg.
    save(flat_icon(1024, None, BRAND, scale=0.55), os.path.join(ASSETS, "splash-icon.png"))

    # Android adaptive icon: solid background layer + transparent foreground
    # glyph kept inside the ~66% safe zone (launchers mask/crop the rest).
    save(Image.new("RGBA", (512, 512), BG), os.path.join(ASSETS, "android-icon-background.png"))
    save(flat_icon(512, None, BRAND, scale=0.42), os.path.join(ASSETS, "android-icon-foreground.png"))
    save(flat_icon(432, None, WHITE, scale=0.42), os.path.join(ASSETS, "android-icon-monochrome.png"))

    # Favicon — small, so keep the shape bold/simple (already is).
    save(flat_icon(48, BG, BRAND, scale=0.66), os.path.join(ASSETS, "favicon.png"))

    # PWA manifest icons (served from public/, copied verbatim to dist root).
    save(flat_icon(192, BG, BRAND, scale=0.62), os.path.join(PUBLIC_ICONS, "icon-192.png"))
    save(flat_icon(512, BG, BRAND, scale=0.62), os.path.join(PUBLIC_ICONS, "icon-512.png"))
    # Maskable: content must fit the ~80% safe-zone circle Android may crop to.
    save(flat_icon(512, BG, BRAND, scale=0.46), os.path.join(PUBLIC_ICONS, "maskable-icon-512.png"))
    # iOS home-screen icon — opaque, no alpha; iOS applies its own rounding.
    save(flat_icon(180, BG, BRAND, scale=0.62), os.path.join(PUBLIC, "apple-touch-icon.png"))


if __name__ == "__main__":
    main()
