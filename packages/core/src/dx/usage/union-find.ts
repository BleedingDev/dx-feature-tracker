export class UnionFind {
  private readonly parent = new Map<string, string>();

  add(key: string): void {
    if (!this.parent.has(key)) {
      this.parent.set(key, key);
    }
  }

  find(key: string): string {
    let root = key;

    while (this.parent.get(root) !== root) {
      root = this.parent.get(root) ?? root;
    }

    let node = key;

    while (node !== root) {
      const next = this.parent.get(node) ?? root;
      this.parent.set(node, root);
      node = next;
    }

    return root;
  }

  nodes(): IterableIterator<string> {
    return this.parent.keys();
  }

  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }
}
