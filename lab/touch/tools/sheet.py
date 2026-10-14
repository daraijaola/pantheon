"""Contact sheet: python -I sheet.py <out.png> <tile px> <columns> <bg hex or 'magenta'> <images...>"""
import sys
from PIL import Image

out, tile, cols, bg, files = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], sys.argv[5:]
color = (255, 0, 255) if bg == "magenta" else tuple(int(bg[i : i + 2], 16) for i in (0, 2, 4))
rows = (len(files) + cols - 1) // cols
sheet = Image.new("RGB", (cols * tile, rows * tile), (255, 255, 255))
for i, f in enumerate(files):
    im = Image.open(f).convert("RGBA").resize((tile, tile), Image.LANCZOS)
    cell = Image.new("RGBA", (tile, tile), color + (255,))
    cell.alpha_composite(im)
    sheet.paste(cell.convert("RGB"), ((i % cols) * tile, (i // cols) * tile))
sheet.save(out)
