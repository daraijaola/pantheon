"""Prepare each cut-out for the code renderer: local contrast for the tones, a map of the drawn lines.

Usage: python -I tonemap.py <cut dir> <out dir> [names...]
Writes <out>/<name>.png: red = tone (0 dark .. 255 light), green = line strength, alpha = the person.
"""
import sys
from pathlib import Path

import cv2
import numpy as np

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
names = sys.argv[3:] or sorted(p.stem for p in src.glob("*.png") if not p.stem.endswith(".src"))
for name in names:
    rgba = cv2.imread(str(src / f"{name}.png"), cv2.IMREAD_UNCHANGED)
    alpha = rgba[:, :, 3]
    gray = cv2.cvtColor(rgba[:, :, :3], cv2.COLOR_BGR2GRAY)
    # Local contrast, so features in flat or tinted areas (cyan hair, purple light) still separate.
    tone = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(6, 6)).apply(gray)
    # The show's own ink lines: thin strokes darker than what surrounds them.
    hat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    line = np.clip(hat.astype(np.float32) * 4.0, 0, 255).astype(np.uint8)
    line[alpha < 128] = 0
    outimg = np.dstack([np.zeros_like(tone), line, tone, alpha])  # BGRA: blue unused, green line, red tone
    cv2.imwrite(str(out / f"{name}.png"), outimg)
    print(name, "ok")
