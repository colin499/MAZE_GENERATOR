/** Knobs for the generation pipeline. All stages are deterministic given these plus the seed. */
export interface GenParams {
  /** Growing-tree: probability of extending the newest frontier cell (1 = recursive backtracker). */
  readonly newestBias: number;
  /** Probability of continuing straight when carving, 0 = no preference. */
  readonly straightBias: number;
  /** Trap holes (ball falls out, restart) to place per layer. */
  readonly trapsPerLayer: number;
  /** Max lateral distance from the layer's solution path for a trap. */
  readonly trapRadius: number;
  /** Solution-path passages to hide under a lifted wall (bridge tunnels). */
  readonly bridges: number;
  /** Fraction of dead ends to open into loops. */
  readonly braid: number;
}

export const DEFAULT_GEN_PARAMS: GenParams = {
  newestBias: 0.8,
  straightBias: 0,
  trapsPerLayer: 2,
  trapRadius: 3,
  bridges: 0,
  braid: 0,
};

export function normalizeGenParams(p: Partial<GenParams> | undefined): GenParams {
  const g = { ...DEFAULT_GEN_PARAMS, ...(p ?? {}) };
  return {
    newestBias: clamp01(g.newestBias),
    straightBias: clamp01(g.straightBias),
    trapsPerLayer: Math.max(0, Math.floor(g.trapsPerLayer)),
    trapRadius: Math.max(1, Math.floor(g.trapRadius)),
    bridges: Math.max(0, Math.floor(g.bridges)),
    braid: clamp01(g.braid),
  };
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
