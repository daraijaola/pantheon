// PANTHEON's icons are 7 × 7 pixel grids drawn in the text colour: "#" is a full pixel.

const path = (rows: string[]) =>
  rows.map((row, y) => [...row].map((c, x) => (c === "#" ? `M${x} ${y}h1v1h-1z` : "")).join("")).join("");

export const SEND = path(["...#...", "..###..", ".#.#.#.", "#..#..#", "...#...", "...#...", "...#..."]);
export const STOP = path([".......", ".#####.", ".#####.", ".#####.", ".#####.", ".#####.", "......."]);
export const PLUS = path(["...#...", "...#...", "...#...", "#######", "...#...", "...#...", "...#..."]);
export const COPY = path(["..#####", "..#...#", "###...#", "#.#...#", "#.#####", "#...#..", "#####.."]);
export const CHECK = path([".......", "......#", ".....#.", "#...#..", ".#.#...", "..#....", "......."]);
export const AGAIN = path([".####..", "#....#.", "#.....#", "#...###", "#....#.", ".#.....", "..####."]);
export const DOWN = path(["...#...", "...#...", "...#...", "#..#..#", ".#.#.#.", "..###..", "...#..."]);

export function Pixels({ d, size = 14, className }: { d: string; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 7 7" width={size} height={size} fill="currentColor" shapeRendering="crispEdges" aria-hidden="true" className={className}>
      <path d={d} />
    </svg>
  );
}
