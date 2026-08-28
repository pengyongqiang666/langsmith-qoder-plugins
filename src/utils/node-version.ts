/** Minimum Node supported by the langsmith SDK. */
export const MIN_NODE: readonly [number, number] = [18, 0];

/**
 * True if `version` (e.g. `process.versions.node` → "22.12.1") is older than
 * `min` = [major, minor]. Pre-release / non-numeric suffixes are tolerated; an
 * unparseable major returns false (don't block when we can't tell).
 */
export function nodeTooOld(version: string, min: readonly [number, number] = MIN_NODE): boolean {
  const parts = version.split(".");
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(major)) return false;
  if (major !== min[0]) return major < min[0];
  return (Number.isFinite(minor) ? minor : 0) < min[1];
}
