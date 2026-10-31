import { lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// This is public runtime metadata, not the repository's scripts or credentials.
export const DESKTOP_PACKAGE_BOUNDARY = `${JSON.stringify({
  name: 'seqivo-desktop-runtime',
  private: true,
  type: 'module',
}, null, 2)}\n`;

export function writeDesktopPackageBoundary(resourceRoot) {
  const root = lstatSync(resourceRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('Packaged resource root is not a real directory');
  }
  const destination = join(resourceRoot, 'package.json');
  writeFileSync(destination, DESKTOP_PACKAGE_BOUNDARY, { flag: 'wx', mode: 0o644 });
  return destination;
}
