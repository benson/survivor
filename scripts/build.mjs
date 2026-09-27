import { cp, mkdir } from 'node:fs/promises';
// Explicit public allowlist: worker code, secrets, tests and local output never deploy.
await mkdir('dist', { recursive: true });
for (const path of ['index.html', 'app.js', 'style.css', 'assets', 'src', 'data', 'CNAME']) {
  await cp(path, `dist/${path}`, { recursive: true });
}
console.log('Built public site in dist/');
