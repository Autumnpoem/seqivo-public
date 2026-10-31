import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(root, '../../..');
for (const theme of ['light', 'dark']) {
  const output = path.join(root, 'exports', theme);
  execFileSync(process.execPath, [path.join(project, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', path.join(root, `icon-${theme}.svg`), '--output', output], { stdio: 'inherit', cwd: project });
  // This kit targets desktop. Mobile platforms need dedicated background/mask assets.
  for (const platform of ['android', 'ios']) await rm(path.join(output, platform), { recursive: true, force: true });
}
