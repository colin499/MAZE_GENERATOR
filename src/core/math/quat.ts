import type { Vec3 } from './vec';
import { cross3, dot3, len3, norm3 } from './vec';

/** Unit quaternion [x, y, z, w]. */
export type Quat = readonly [number, number, number, number];

export const QUAT_ID: Quat = [0, 0, 0, 1];

export function quatAxisAngle(axis: Vec3, angle: number): Quat {
  const a = norm3(axis);
  const s = Math.sin(angle / 2);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)];
}

/** q = a ∘ b (apply b first, then a). */
export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export const quatConj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]];
  const s = q[3];
  const uv = cross3(u, v);
  const uuv = cross3(u, uv);
  return [
    v[0] + 2 * (s * uv[0] + uuv[0]),
    v[1] + 2 * (s * uv[1] + uuv[1]),
    v[2] + 2 * (s * uv[2] + uuv[2]),
  ];
}

/** Smallest rotation taking unit vector a onto unit vector b, with the angle capped at `maxAngle`. */
export function quatBetween(a: Vec3, b: Vec3, maxAngle = Math.PI): Quat {
  const c = Math.max(-1, Math.min(1, dot3(a, b)));
  const angle = Math.min(Math.acos(c), maxAngle);
  if (angle < 1e-9) return QUAT_ID;
  let axis = cross3(a, b);
  if (len3(axis) < 1e-9) {
    // antiparallel: pick any perpendicular axis
    axis = Math.abs(a[0]) < 0.9 ? cross3(a, [1, 0, 0]) : cross3(a, [0, 1, 0]);
  }
  return quatAxisAngle(axis, angle);
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
