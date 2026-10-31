import {inspectPackage,installPackage,scaffoldPackage} from '../server/plugin-packages.mjs';
const [action,...args]=process.argv.slice(2),arg=key=>args[args.indexOf(key)+1];
if(action==='create')console.log(JSON.stringify(await scaffoldPackage({id:arg('--id'),directory:arg('--directory')}),null,2));
else if(action==='inspect'){const {manifest,bytes,sha256}=await inspectPackage(arg('--source'));console.log(JSON.stringify({manifest,bytes,sha256},null,2));}
else if(action==='install')console.log(JSON.stringify(await installPackage({source:arg('--source'),target:arg('--target'),expectedSha256:arg('--sha256'),trustLocalCode:args.includes('--trust-local-code')}),null,2));
else throw Error('Use create --id ID --directory NEW_DIR | inspect --source DIR | install --source DIR --target EXTENSIONS_DIR --sha256 HASH --trust-local-code');
