import type { Vec3 } from '../math/vec';
import type { ParamDef } from './physical';

/** A length that Fusion evaluates from an expression; `mm` is the value at export time. */
export interface Expr {
  readonly mm: number;
  readonly expr: string;
}

/** Sketch plane: an XY construction plane offset by a parametric expression. */
export interface PlaneSpec {
  readonly kind: 'xyOffset';
  readonly offset: Expr;
}

/** All points are 3D model coordinates in mm; the interpreter maps them into sketch space. */
export type Feature =
  | {
      readonly op: 'extrude';
      readonly name: string;
      readonly plane: PlaneSpec;
      readonly polygons: readonly (readonly Vec3[])[];
      readonly distance: Expr;
      readonly start?: Expr;
      readonly mode: 'new' | 'join' | 'cut';
      readonly body: string;
    }
  | {
      readonly op: 'thin';
      readonly name: string;
      readonly plane: PlaneSpec;
      readonly segments: readonly (readonly [Vec3, Vec3])[];
      readonly thickness: Expr;
      readonly distance: Expr;
      readonly start?: Expr;
      readonly body: string;
    }
  | {
      readonly op: 'holes';
      readonly name: string;
      readonly plane: PlaneSpec;
      readonly points: readonly Vec3[];
      readonly diameter: Expr;
      readonly depth: Expr;
      readonly body: string;
    };

export interface FeatureGroup {
  /** Timeline group name, e.g. "Layer 2". */
  readonly name: string;
  /** Body whose existence marks this group as already built (idempotent re-runs). */
  readonly marker: string;
  readonly features: readonly Feature[];
}

export interface BuildPlan {
  readonly componentName: string;
  readonly params: readonly ParamDef[];
  readonly groups: readonly FeatureGroup[];
  readonly expected: {
    readonly bodies: number;
    readonly bboxMm: { readonly min: Vec3; readonly max: Vec3 };
    /** Rough total solid volume in mm³ (walls estimated from run lengths). */
    readonly volumeMm3: number;
  };
  readonly meta: { readonly seed: string; readonly topology: string; readonly generator: string };
}
