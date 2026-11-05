/** Dense cell index, 0..cellCount-1, assigned by the topology. */
export type CellId = number & { readonly __brand: 'CellId' };
export const cellId = (n: number): CellId => n as CellId;

/** Canonical key for an unordered cell pair. */
export type EdgeKey = string & { readonly __brand: 'EdgeKey' };
export function edgeKey(a: CellId, b: CellId): EdgeKey {
  return (a < b ? `${a}:${b}` : `${b}:${a}`) as EdgeKey;
}
export function parseEdgeKey(k: EdgeKey): [CellId, CellId] {
  const i = k.indexOf(':');
  return [cellId(Number(k.slice(0, i))), cellId(Number(k.slice(i + 1)))];
}
