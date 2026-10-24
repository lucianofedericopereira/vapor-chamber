/**
 * vapor-chamber - the action pattern, read in one place.
 *
 * A pattern ending in `*` matches every action that starts with the text
 * before it, so `'*'` matches every action. Any other pattern is one action's
 * name. The bus routes by it (`on()`, `offAll()`, a plugin's scope, the
 * transport map), and authGuard's `protected` list reads it. It holds no bus
 * state, so it sits in the foundation beside dict.ts.
 */

// Pre-sliced prefix cache for wildcard patterns - avoids slice() on every match.
// Capped at 256 entries to prevent unbounded growth in long-running processes.
const _prefixCache = new Map<string, string>();
const _PREFIX_CACHE_MAX = 256;

/**
 * @internal The one pattern classifier. A pattern ending in `*` matches every
 * action that starts with the text before it, so `'*'` (prefix `''`) matches
 * every action: its prefix is returned. Any other pattern is one action's
 * name: undefined. `on()`, `offAll()`, `matchesPattern`, `_scoped`,
 * `mostSpecific` and authGuard read it. tests/pattern-classifier.test.ts.
 */
export function _patternPrefix(pattern: string): string | undefined {
  return pattern.charCodeAt(pattern.length - 1) === 42 /* '*' */ ? pattern.slice(0, -1) : undefined;
}

export function matchesPattern(pattern: string, action: string): boolean {
  let prefix = _prefixCache.get(pattern);
  if (prefix === undefined) {
    prefix = _patternPrefix(pattern);
    if (prefix === undefined) return pattern === action;
    if (_prefixCache.size >= _PREFIX_CACHE_MAX) _prefixCache.delete(_prefixCache.keys().next().value!);
    _prefixCache.set(pattern, prefix);
  }
  return action.startsWith(prefix);
}
