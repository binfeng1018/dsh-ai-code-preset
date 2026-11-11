import {readFile,writeFile,mkdir} from 'node:fs/promises';
const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
let source=await readFile(new URL('../src/client.js',import.meta.url),'utf8');
const repository=typeof pkg.repository==='string'?pkg.repository:pkg.repository?.url?.replace(/^git\+/, '');
if(repository){
 if(!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(repository))throw new Error('repository must be a real canonical GitHub project URL');
 source=source.replace('/* REPOSITORY_CONFIGURATION */',`descriptor.repository = ${JSON.stringify(repository)};`);
}else console.warn('UNCONFIGURED: host 1.2.0 needs real repository attribution before the workbench can appear. Package is development-only until configured.');
await mkdir(new URL('../lib/',import.meta.url),{recursive:true});
await writeFile(new URL('../lib/client.js',import.meta.url),source);
console.log('Built single-file client. No dependencies downloaded.');
