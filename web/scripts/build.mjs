import { cp, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=new URL('../',import.meta.url),dest=new URL('../dist/',import.meta.url);
await mkdir(dest,{recursive:true});
for(const file of ['index.html','docs.html','style.css','edition.css','app.js','globe.js','canvas-globe.js','mechanics.js'])await copyFile(new URL(file,root),new URL(file,dest));
await cp(new URL('assets/',root),new URL('assets/',dest),{recursive:true});
console.log(`Static site built: ${fileURLToPath(dest)}`);
