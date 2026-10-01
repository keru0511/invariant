/** Input paths address scalar leaves in an ordinary JSON object tree. */
export function isDomainInputPath(path: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(path);
}

export function inputPathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(right + '.') || right.startsWith(left + '.');
}
