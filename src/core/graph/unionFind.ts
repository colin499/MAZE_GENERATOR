export class UnionFind {
  private readonly parent: Int32Array;
  private readonly rank: Uint8Array;
  count: number;

  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
    this.rank = new Uint8Array(n);
    this.count = n;
  }

  find(x: number): number {
    let r = x;
    while (this.parent[r] !== r) r = this.parent[r]!;
    while (this.parent[x] !== r) {
      const next = this.parent[x]!;
      this.parent[x] = r;
      x = next;
    }
    return r;
  }

  /** Returns true if a merge happened. */
  union(a: number, b: number): boolean {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return false;
    if (this.rank[ra]! < this.rank[rb]!) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    if (this.rank[ra] === this.rank[rb]) this.rank[ra]!++;
    this.count--;
    return true;
  }

  connected(a: number, b: number): boolean {
    return this.find(a) === this.find(b);
  }
}
