/** Small source fixture indexed by the real engine during browser checks. */
export class GraphEngine {
  retrieve(query: string): string[] {
    return this.rank(query);
  }

  private rank(query: string): string[] {
    return query.split(/\s+/).filter(Boolean);
  }
}
