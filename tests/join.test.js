import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';

test('signed-in newcomers join without codes and cannot claim commissioner access', async () => {
  const { request, sql } = fixture();
  assert.equal((await request('/join', { user: null, method: 'POST', body: { name: 'Ellie' } })).status, 401);
  assert.equal((await request('/join', { user: 'ellie', method: 'POST', body: { name: ' ' } })).status, 400);
  assert.equal((await request('/join', { user: 'ellie', method: 'POST', body: { name: 'Ellie', role: 'admin', userId: 'owner' } })).status, 200);
  const me = (await request('/me', { user: 'ellie' })).data;
  assert.equal(me.member.name, 'Ellie');
  assert.equal(me.member.role, 'member');
  assert.equal((await request('/league', { user: 'ellie' })).status, 200);
  assert.equal((await request('/admin/settings', { user: 'ellie', method: 'PUT', body: { open: false, revision: 0 } })).status, 403);
  assert.equal((await request('/join', { user: 'ellie', method: 'POST', body: { name: 'Changed' } })).status, 200);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM members WHERE user_id='ellie'").get().n, 1);
  assert.equal((await request('/me', { user: 'ellie' })).data.member.name, 'Ellie');
  assert.equal((await request('/me', { user: 'owner' })).data.member.role, 'admin');
});
