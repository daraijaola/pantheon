import { GLYPHS, GLYPH_ROWS, TRACKING } from "./glyphs";

/** A static word in the PANTHEON bitmap face (crisp SVG, no JS). Used for the logo. */
export function CodeWordmark({ text, module = 2.4, className }: { text: string; module?: number; className?: string }) {
  const rects: { x: number; y: number; w: number }[] = [];
  let x = 0;
  [...text].forEach((ch, i) => {
    if (i) x += TRACKING;
    const g = GLYPHS[ch];
    g.forEach((row, y) => {
      // Merge each horizontal run of pixels into one rect.
      for (let c = 0; c < row.length; ) {
        if (row[c] !== "#") {
          c++;
          continue;
        }
        let end = c;
        while (end < row.length && row[end] === "#") end++;
        rects.push({ x: x + c, y, w: end - c });
        c = end;
      }
    });
    x += g[0].length;
  });

  return (
    <svg
      viewBox={`0 0 ${x} ${GLYPH_ROWS}`}
      width={x * module}
      height={GLYPH_ROWS * module}
      fill="currentColor"
      shapeRendering="crispEdges"
      role="img"
      aria-label={text}
      className={className}
    >
      {rects.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} />
      ))}
    </svg>
  );
}
