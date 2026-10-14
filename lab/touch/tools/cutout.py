"""Crop each character's head and shoulders from an official still and cut the person out.

Usage: python -I cutout.py <raw dir> <out dir> <model> [names...]
Writes <out>/<name>.png: a 1000 x 1000 RGBA portrait with the background removed.
"""
import sys
from pathlib import Path

from PIL import Image
from rembg import new_session, remove

# name: (still, x, y, size) in the still's own pixels; the square is the portrait.
CROPS = {
    "caspian": ("caspian-b", 250, 0, 864),
    "maddie": ("maddie-a", 410, 0, 1080),
    "maddie-orb": ("caspian-maddie", 290, 40, 860),
    "maddie-adult": ("maddie-c", 600, 40, 860),
    "david": ("david", 380, 100, 960),
    "david-young": ("david-ellen-maddie", 900, 0, 740),
    "ellen": ("ellen-maddie", 470, 0, 560),
    "cary": ("cary-caspian", 555, 90, 990),
    "holstrom": ("holstrom-pope-b", 570, 110, 680),
    "yair": ("caspian-yair", 410, 30, 700),
    "mist": ("caspian-mist", 290, 120, 800),
    "joey": ("caspian-joey", 1060, 60, 700),
    "laurie": ("laurie", 10, 60, 960),
    "renee": ("holstrom-cary-pope-renee", 1085, 175, 400),
    "pope": ("holstrom-cary-pope-renee", 370, 140, 420),
}

raw, out, model = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
names = sys.argv[4:] or list(CROPS)
out.mkdir(parents=True, exist_ok=True)
session = new_session(model)
for name in names:
    still, x, y, s = CROPS[name]
    img = Image.open(raw / f"{still}.jpg").convert("RGB")
    crop = img.crop((x, y, x + s, y + s)).resize((1000, 1000), Image.LANCZOS)
    cut = remove(crop, session=session)
    cut.save(out / f"{name}.png")
    crop.save(out / f"{name}.src.png")
    print(name, "ok")
