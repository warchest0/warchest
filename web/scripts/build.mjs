import { cp, mkdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=new URL('../',import.meta.url),dest=new URL('../dist/',import.meta.url);
await rm(dest,{recursive:true,force:true});
await mkdir(dest,{recursive:true});
for(const file of ['index.html','docs.html','style.css','app.js','mechanics.js','globe.js','canvas-globe.js'])await copyFile(new URL(file,root),new URL(file,dest));
await cp(new URL('assets/',root),new URL('assets/',dest),{recursive:true});
console.log(`Static site built: ${fileURLToPath(dest)}`);
