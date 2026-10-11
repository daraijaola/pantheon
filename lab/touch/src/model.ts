// The two hands of the Creation of Adam, as tapered capsules in "hand space":
// the hand points to +x, y is down, z is toward the viewer, and the wrist sits at (0, 0).

export type Joint = [x: number, y: number, r: number];
export type Chain = { name: string; z: number; joints: Joint[]; blend?: number };

export const GOD: Chain[] = [
  { name: "arm", z: 0, joints: [[-340, -8, 36], [-190, -5, 39], [-8, 0, 25]] },
  { name: "palm", z: 2, joints: [[0, -12, 16], [84, -14, 14]], blend: 12 },
  { name: "palm", z: 2, joints: [[2, 11, 16], [80, 9, 14]], blend: 12 },
  { name: "palm", z: 3, joints: [[0, 0, 20], [84, -2, 18]], blend: 12 },
  { name: "index", z: 9, joints: [[86, -14, 10.5], [132, -15, 9.5], [160, -14, 8.5], [181, -12, 7]] },
  { name: "middle", z: 5, joints: [[86, -3, 10.5], [128, 8, 9.8], [122, 30, 8.8], [104, 36, 7.5]] },
  { name: "ring", z: 2, joints: [[84, 7, 10], [120, 17, 9.4], [114, 37, 8.5], [98, 41, 7.2]] },
  { name: "pinky", z: -1, joints: [[78, 15, 9], [106, 24, 8.4], [102, 39, 7.6], [90, 42, 6.6]] },
  { name: "thumb", z: 11, joints: [[16, 14, 13], [44, 30, 11.5], [66, 36, 10], [84, 34, 8.5]] },
];

export const ADAM: Chain[] = [
  { name: "arm", z: 0, joints: [[-340, 10, 34], [-190, 6, 37], [-8, 0, 24]] },
  { name: "palm", z: 3, joints: [[0, 0, 20], [80, 22, 18]], blend: 12 },
  { name: "palm", z: 3, joints: [[0, -11, 15], [84, 8, 13]], blend: 12 },
  { name: "palm", z: 2, joints: [[2, 11, 15], [74, 33, 13]], blend: 12 },
  { name: "index", z: 9, joints: [[84, 10, 10.5], [128, 18, 9.5], [154, 26, 8.5], [172, 36, 7]] },
  { name: "middle", z: 5, joints: [[82, 21, 10.5], [122, 36, 9.6], [142, 52, 8.6], [152, 66, 7.3]] },
  { name: "ring", z: 2, joints: [[78, 30, 10], [112, 47, 9.2], [126, 63, 8.2], [132, 76, 7]] },
  { name: "pinky", z: -1, joints: [[70, 37, 9], [96, 52, 8.2], [106, 65, 7.4], [110, 76, 6.4]] },
  { name: "thumb", z: -2, joints: [[10, 16, 12], [34, 30, 10.5], [52, 37, 9], [64, 37, 7.5]] },
];

/** A tapered capsule in scene units, ready to rasterise. */
export type Capsule = { ax: number; ay: number; bx: number; by: number; ra: number; rb: number; z: number };

export type Pose = {
  scale: number; // hand size
  angle: number; // degrees, whole arm
  mirror: boolean; // God's hand points left
  tipX: number; // where the index fingertip lands (scene units)
  tipY: number;
};

export type PlacedChain = { caps: Capsule[]; blend?: number };

export function placeHand(chains: Chain[], p: Pose): PlacedChain[] {
  const a = (p.angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const tf = (x: number, y: number): [number, number] => {
    const rx = (x * c - y * s) * p.scale;
    const ry = (x * s + y * c) * p.scale;
    return [p.mirror ? -rx : rx, ry];
  };
  const index = chains.find((ch) => ch.name === "index")!;
  const tip = index.joints[index.joints.length - 1];
  const [tx, ty] = tf(tip[0], tip[1]);
  const dx = p.tipX - tx;
  const dy = p.tipY - ty;
  const out: PlacedChain[] = [];
  for (const ch of chains) {
    const caps: Capsule[] = [];
    out.push({ caps, blend: ch.blend });
    for (let i = 0; i < ch.joints.length - 1; i++) {
      const [ax, ay] = tf(ch.joints[i][0], ch.joints[i][1]);
      const [bx, by] = tf(ch.joints[i + 1][0], ch.joints[i + 1][1]);
      caps.push({
        ax: ax + dx,
        ay: ay + dy,
        bx: bx + dx,
        by: by + dy,
        ra: ch.joints[i][2] * p.scale,
        rb: ch.joints[i + 1][2] * p.scale,
        z: ch.z * p.scale,
      });
    }
  }
  return out;
}
