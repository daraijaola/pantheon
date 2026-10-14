// Lab page: every cut-out portrait in both looks, plus a save hook for the export script.
import source from "../section3/code.sol.txt?raw";
import { drawPortrait, type Variant } from "./render";

const code = source
  .slice(Math.max(0, source.indexOf("contract ")))
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("")
  .replace(/\s+/g, "");
const params = new URLSearchParams(location.search);
const dir = params.get("dir") ?? "tone";
const names = (params.get("names") ?? "").split(",").filter(Boolean);
const cols = Number(params.get("cols") ?? 170);
const MONO = '"Geist Mono"';

const load = (src: string) =>
  new Promise<HTMLImageElement>((ok, fail) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = fail;
    im.src = src;
  });

await document.fonts.load(`500 20px ${MONO}`);
const out: Record<string, string> = {};
for (const name of names) {
  const img = await load(`/research/pantheon/${dir}/${name}.png`);
  for (const v of ["light", "dark"] as Variant[]) {
    const c = drawPortrait(img, code, v, 1000, cols);
    c.style.width = "250px";
    c.style.margin = "6px";
    c.title = `${name} ${v}`;
    document.body.append(c);
    out[`${name}-${v}`] = c.toDataURL("image/png");
  }
}
(window as unknown as { __portraits: Record<string, string> }).__portraits = out;
document.body.dataset.ready = "1";
