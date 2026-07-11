/** True when the recent handoff history shows A↔B oscillation at/above `threshold` hops
 *  between the same unordered pair, counting the pending from→to as the latest hop. */
export function isHandoffOscillating(
  history: Array<{ from: string; to: string }>,
  pendingFrom: string,
  pendingTo: string,
  threshold: number,
): boolean {
  const pairKey = (a: string, b: string) => [a, b].sort().join('\0');
  const target = pairKey(pendingFrom, pendingTo);
  let count = 1; // the pending hop
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i];
    if (!h) break;
    if (pairKey(h.from, h.to) === target) count += 1;
    else break; // only CONSECUTIVE same-pair hops count as oscillation
  }
  return count >= threshold;
}