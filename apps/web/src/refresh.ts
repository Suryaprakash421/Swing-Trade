// API responses contain JSON values. Keep existing references for unchanged results.
export function retainEqual<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

export type RefreshScope = 'account' | 'market' | 'all';

export function mergeRefreshScope(a: RefreshScope, b: RefreshScope): RefreshScope {
  if (a === 'all' || b === 'all') return 'all';
  return a === 'market' || b === 'market' ? 'market' : 'account';
}
