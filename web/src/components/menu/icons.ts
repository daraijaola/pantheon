// Pixel icons for the menu, 7 × 7 like Firecrawl's dot-matrix ones, but drawn in our ink.
// "#" is a full pixel, "+" a half-tone one. GlitchIcon decrypts them in and glitches them.

export const ICONS = {
  // an ID photo: a person in a frame
  passport: [
    "#######", //
    "#.....#",
    "#..#..#",
    "#.###.#",
    "#.###.#",
    "#.....#",
    "#######",
  ],
  // a tick: a vote cast
  trials: [
    ".......", //
    "......#",
    ".....#+",
    "#...#+.",
    "+#.#+..",
    ".+#+...",
    "..+....",
  ],
  // a padlock: rules locked
  covenant: [
    "..###..", //
    ".#+.+#.",
    ".#...#.",
    "#######",
    "###.###",
    "###+###",
    "#######",
  ],
  // an eye: the oracle
  delphi: [
    ".......", //
    "..###..",
    ".#+++#.",
    "#+.#.+#",
    ".#+++#.",
    "..###..",
    ".......",
  ],
  // a page of text
  terms: [
    "#####..", //
    "#...#+.",
    "#.##.##",
    "#.....#",
    "#.###.#",
    "#.....#",
    "#######",
  ],
  // a prompt: the code
  github: [
    ".......", //
    "#+.....",
    "+#+....",
    "..#+...",
    "+#+....",
    "#+.####",
    ".......",
  ],
  // the X mark
  x: [
    "#+...+#", //
    "+#...#+",
    "..#.#..",
    "...#...",
    "..#.#..",
    "+#...#+",
    "#+...+#",
  ],
  // an arrow up and out: a partner site
  out: [
    "..#####", //
    "....+##",
    "...+#+#",
    "..+#+.#",
    ".+#+...",
    "+#+....",
    "#+.....",
  ],
} as const;

export type IconName = keyof typeof ICONS;
