export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];
export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const norm3 = (a: Vec3): Vec3 => {
  const l = len3(a);
  return l === 0 ? a : scale3(a, 1 / l);
};

/** Orthonormal frame: origin plus local x, y axes; z = x × y. */
export interface Frame {
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
}

export const frameZ = (f: Frame): Vec3 => cross3(f.x, f.y);

/** Map local (u, v, w) in the frame to world coordinates. */
export function frameToWorld(f: Frame, u: number, v: number, w = 0): Vec3 {
  const z = frameZ(f);
  return [
    f.origin[0] + f.x[0] * u + f.y[0] * v + z[0] * w,
    f.origin[1] + f.x[1] * u + f.y[1] * v + z[1] * w,
    f.origin[2] + f.x[2] * u + f.y[2] * v + z[2] * w,
  ];
}
