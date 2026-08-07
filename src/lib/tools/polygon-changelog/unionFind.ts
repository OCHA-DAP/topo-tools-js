// Path-compressed disjoint-set union over string keys: nodes are "a:<fid>"/
// "b:<fid>", edges are pair rows passing tauMatch (the bipartite match graph).

export class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  add(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: string): string {
    let p = this.parent.get(x);
    if (p === undefined) {
      this.add(x);
      return x;
    }
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }

  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const raRank = this.rank.get(ra) ?? 0;
    const rbRank = this.rank.get(rb) ?? 0;
    if (raRank < rbRank) {
      this.parent.set(ra, rb);
    } else if (raRank > rbRank) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, raRank + 1);
    }
  }

  components(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const x of this.parent.keys()) {
      const r = this.find(x);
      let arr = out.get(r);
      if (!arr) {
        arr = [];
        out.set(r, arr);
      }
      arr.push(x);
    }
    return out;
  }
}
