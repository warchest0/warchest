import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
const root = new URL('../.vercel/output/', import.meta.url);
const html = await readFile(new URL('static/index.html', root), 'utf8');
assert.match(html, /Owned by conviction/);
assert.match(html, /href="\/dashboard\/\?preview=1"/);
assert.doesNotMatch(html, /data-open-app/);
for (const path of ['docs.html', 'dashboard/index.html', 'vote/index.html', 'treasury/index.html', 'leaderboard/index.html', '404.html', 'app.js', 'edition.css', 'assets/earth.jpg', 'assets/world.geojson', 'assets/InterVariable.woff2']) {
  await access(new URL(`static/${path}`, root));
}
const dashboard = await readFile(new URL('static/dashboard/index.html', root), 'utf8');
assert.match(dashboard, /_next\/static/);
const config = JSON.parse(await readFile(new URL('config.json', root), 'utf8'));
assert.equal(config.version, 3);
assert.equal(config.routes.at(-1).status, 404);
console.log('Verified: marketing homepage, app entry link, all app routes, local assets, and 404 routing.');
