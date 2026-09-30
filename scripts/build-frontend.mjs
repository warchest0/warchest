import { cp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Assemble both independently built frontends into Vercel's static Build Output API.
const root = new URL('../', import.meta.url);
const output = new URL('.vercel/output/', root);
const staticDir = new URL('static/', output);
for (const path of ['app/out/dashboard/index.html', 'web/dist/index.html']) {
  await access(new URL(path, root));
}
await rm(output, { recursive: true, force: true });
await mkdir(staticDir, { recursive: true });
await cp(new URL('app/out/', root), staticDir, { recursive: true });
await cp(new URL('web/dist/', root), staticDir, { recursive: true });
await writeFile(new URL('config.json', output), JSON.stringify({
  version: 3,
  routes: [
    { src: '/(.*)', headers: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' }, continue: true },
    { handle: 'filesystem' },
    { src: '/.*', status: 404, dest: '/404.html' }
  ]
}, null, 2) + '\n');
console.log(`Combined frontend: ${fileURLToPath(staticDir)}`);
