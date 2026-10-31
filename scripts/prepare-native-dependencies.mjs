import {chmodSync, existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';

// npm archives may lose the executable bit on the macOS PTY helper.
// Repair only this installed dependency's known helper, never a user executable.
export function prepareNativeDependencies(){
  const require=createRequire(import.meta.url);
  const root=dirname(require.resolve('node-pty/package.json'));
  if(process.platform==='darwin'){
    for(const helper of [join(root,'prebuilds',`${process.platform}-${process.arch}`,'spawn-helper'),join(root,'build','Release','spawn-helper')]){
      if(existsSync(helper))chmodSync(helper,0o755);
    }
  }
}
prepareNativeDependencies();
