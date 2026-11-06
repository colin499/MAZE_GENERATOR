import type { Vec3 } from '../math/vec';
import type { ParamDef } from './physical';

/** A length that Fusion evaluates from an expression; `mm` is the value at export time. */
export interface Expr {
  readonly mm: number;
  readonly expr: string;
}

export type BasePlane = 'XY' | 'XZ' | 'YZ';
export type Axis = 'X' | 'Y' | 'Z';

/**
 * Sketch planes Fusion can build parametrically:
 * - xyOffset: the XY plane offset by an expression (positive extrude = +z);
 * - offset: a base plane (optionally flipped so its normal points the other way) offset by an expression;
 * - angle: the plane containing a principal axis, rotated by angleDeg (right-handed) from the base plane
 *   that contains that axis (X, Y → XY; Z → XZ).
 */
export type PlaneSpec =
  | { readonly kind: 'xyOffset'; readonly offset: Expr }
  | { readonly kind: 'offset'; readonly base: BasePlane; readonly flip: boolean; readonly offset: Expr }
  | { readonly kind: 'angle'; readonly axis: Axis; readonly angleDeg: number };

/** Annular sector drawn from model points: two three-point arcs joined by radial lines. */
export interface SectorSpec {
  readonly innerStart: Vec3; readonly innerMid: Vec3; readonly innerEnd: Vec3;
  readonly outerStart: Vec3; readonly outerMid: Vec3; readonly outerEnd: Vec3;
}

export interface CircleSpec {
  readonly center: Vec3;
  readonly diameter: Expr;
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
    }
  | {
      /** Annulus between two concentric circles (diameters are live expressions), extruded. */
      readonly op: 'ring';
      readonly name: string;
      readonly plane: PlaneSpec;
      readonly center: Vec3;
      readonly innerDia: Expr;
      readonly outerDia: Expr;
      readonly distance: Expr;
      readonly mode: 'new' | 'join';
      readonly body: string;
    }
  | {
      /** Disk (live diameter) with optional holes, extruded. */
      readonly op: 'disk';
      readonly name: string;
      readonly plane: PlaneSpec;
      readonly center: Vec3;
      readonly diameter: Expr;
      readonly holes: readonly CircleSpec[];
      readonly distance: Expr;
      readonly mode: 'new' | 'join';
      readonly body: string;
    }
  | {
      /** Annular sectors (baked geometry) extruded symmetrically about the plane by a live thickness. */
      readonly op: 'sectors';
      readonly name: string;
      readonly plane: PlaneSpec;
      readonly sectors: readonly SectorSpec[];
      readonly thickness: Expr;
      readonly body: string;
    }
  | {
      /**
       * Round holes along arbitrary directions: each is a half-rectangle in the plane (corner 0→1 is the
       * hole axis, corners 2–3 lie dia/2 away) revolved 360° about that axis and cut.
       */
      readonly op: 'radialHoles';
      readonly name: string;
      readonly plane: PlaneSpec;
      readonly holes: readonly (readonly [Vec3, Vec3, Vec3, Vec3])[];
      readonly body: string;
    }
  | {
      /** Revolve a profile of lines and three-point arcs 360° about the component's z axis. */
      readonly op: 'revolve';
      readonly name: string;
      readonly plane: PlaneSpec;
      readonly lines: readonly (readonly [Vec3, Vec3])[];
      readonly arcs: readonly (readonly [Vec3, Vec3, Vec3])[];
      readonly mode: 'new' | 'join' | 'cut';
      readonly body: string;
    };

export interface FeatureGroup {
  /** Timeline group name, e.g. "Layer 2". */
  readonly name: string;
  /** Marks this group as already built (idempotent re-runs): a body name, or "feature:<name>". */
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
