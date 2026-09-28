// Browser smoke check with the real app and API, substituting only Clerk identity.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fixture } from '../tests/helpers.js';

const { worker, env, sql } = fixture();
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === 'survivor-draft-api.bensonperry.workers.dev') {
      const response = await worker.fetch(new Request(request.url(), {
        method: request.method(), headers: request.headers(),
        ...(request.postData() ? { body: request.postData() } : {}),
      }), env);
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    if (url.hostname !== 'survivordraft.bensonperry.com') return route.abort();
    if (url.pathname === '/src/auth.js') return route.fulfill({ contentType: 'text/javascript', body: `export async function initAuth(){return {user:{id:'new-family-member',name:'Ellie'},token:async()=>'new-family-member'};}` });
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.json') ? 'application/json' : path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    try { return route.fulfill({ contentType: type, body: await readFile(new URL('..' + path, import.meta.url)) }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('https://survivordraft.bensonperry.com/');
  await page.waitForResponse(r => r.url().endsWith('/league') && r.status() === 200);
  assert.equal(sql.prepare("SELECT role FROM members WHERE user_id='new-family-member'").get().role, 'member');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  for (let i = 0; i < 7; i++) await page.locator('[data-pick]').nth(i).click();
  await page.getByRole('button', { name: 'Save team', exact: true }).first().click();
  await page.getByRole('status').filter({ hasText: 'Team saved.' }).waitFor();
  assert.equal(JSON.parse(sql.prepare("SELECT submitted FROM teams WHERE user_id='new-family-member'").get().submitted).picks.length, 7);
  await page.reload();
  await page.waitForResponse(r => r.url().endsWith('/league') && r.status() === 200);
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM members WHERE user_id='new-family-member'").get().n, 1);
  assert.deepEqual(errors, []);
  console.log('Passed: regular URL → automatic joining → seven picks saved → reload, with no invite prompt.');
} finally { await browser.close(); }
