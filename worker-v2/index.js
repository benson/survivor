import { createRemoteJWKSet, jwtVerify } from 'jose';
import season from '../data/s51/season.json' with { type: 'json' };
import { isOpen, validateTeam, validateResult } from '../src/domain.js';
import { seasonView, preferences } from './episode-store.js';
import { syncResults, scheduledHour } from './automatic-results.js';

const keys = new Map();
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const list = value => String(value || '').split(',').filter(Boolean);
export async function verifySession(request, env) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token) fail('Sign in to continue.', 401);
  if (!keys.has(env.CLERK_ISSUER)) keys.set(env.CLERK_ISSUER, createRemoteJWKSet(new URL(`${env.CLERK_ISSUER}/.well-known/jwks.json`)));
  try {
    const { payload } = await jwtVerify(token, keys.get(env.CLERK_ISSUER), { issuer: env.CLERK_ISSUER, algorithms: ['RS256'], requiredClaims: ['sub', 'sid', 'exp', 'iat', 'nbf', 'azp'], clockTolerance: 5 });
    if (!list(env.CLERK_AUTHORIZED_PARTIES).includes(payload.azp) || payload.sts === 'pending' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') fail('Invalid session.', 401);
    return payload.sub;
  } catch { fail('Your session expired. Sign in again.', 401); }
}
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
const parse = value => value ? JSON.parse(value) : null;
async function body(request) {
  if (!request.headers.get('Content-Type')?.includes('application/json')) fail('Send JSON.', 415);
  const value = await request.text();
  if (value.length > 12000) fail('Request is too large.', 413);
  try { return JSON.parse(value); } catch { fail('Invalid request.'); }
}
async function snapshot(db) {
  return seasonView(db, 30);
}
const teamModel = row => row ? { draft: parse(row.draft), submitted: parse(row.submitted), revision: row.revision, updatedAt: row.updated_at, submittedAt: row.submitted_at } : { draft: null, submitted: null, revision: 0 };

export function createWorker(authenticate = verifySession) {
  return {
    async scheduled(controller, env, ctx) {
      const now = new Date(controller.scheduledTime);
      if (scheduledHour(now)) ctx.waitUntil(syncResults(env, { now }));
    },
    async fetch(request, env) {
      const origin = request.headers.get('Origin');
      const allowed = list(env.CLERK_AUTHORIZED_PARTIES);
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
      if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
      const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
      try {
        if (origin && !allowed.includes(origin)) fail('Origin not allowed.', 403);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
        const path = new URL(request.url).pathname;
        if (path === '/health' && request.method === 'GET') { await env.DB.prepare('SELECT id FROM league').first(); return json({ ok: true, version: 3 }); }
        if (path === '/season' && request.method === 'GET') {
          const viewer = request.headers.has('Authorization') ? await authenticate(request, env) : null;
          const preference = await preferences(env.DB, viewer);
          const guestThrough = Number(new URL(request.url).searchParams.get('through') || 0);
          const through = viewer ? preference.watchedThrough : guestThrough;
          return json({ ...await seasonView(env.DB, through), preferences: preference });
        }
        const userId = await authenticate(request, env);
        const member = await env.DB.prepare('SELECT * FROM members WHERE user_id = ?').bind(userId).first();
        if (path === '/join' && request.method === 'POST') {
          if (member) return json({ member });
          if (env.JOIN_LIMIT && !(await env.JOIN_LIMIT.limit({ key: userId + ':' + (request.headers.get('CF-Connecting-IP') || '') })).success) fail('Too many attempts. Try again in a minute.', 429);
          const input = await body(request);
          if (typeof input.code !== 'string' || input.code.length > 100 || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 40) fail('Enter your name and family invite code.');
          const digest = await hash(input.code.trim());
          const league = await env.DB.prepare('SELECT invite_hash FROM league WHERE id = 1').first();
          const isAdmin = !!env.COMMISSIONER_INVITE_HASH && digest === env.COMMISSIONER_INVITE_HASH;
          if (!isAdmin && (!league.invite_hash || digest !== league.invite_hash)) fail('That invite code is not valid.', 403);
          if (isAdmin && await env.DB.prepare("SELECT user_id FROM members WHERE role = 'admin'").first()) fail('The commissioner account is already claimed.', 409);
          await env.DB.prepare('INSERT INTO members (user_id, name, role) VALUES (?, ?, ?)').bind(userId, input.name.trim(), isAdmin ? 'admin' : 'member').run();
          return json({ ok: true });
        }
        if (path === '/me' && request.method === 'GET') return json({ member, preferences: await preferences(env.DB, userId), team: member ? teamModel(await env.DB.prepare('SELECT * FROM teams WHERE user_id = ?').bind(userId).first()) : null });
        if (path === '/preferences' && request.method === 'PUT') {
          const input = await body(request), latest = await snapshot(env.DB);
          if (!Number.isInteger(input.watchedThrough) || input.watchedThrough < 0 || input.watchedThrough > latest.view.latestEpisode || !Number.isInteger(input.revision) || input.revision < 0) fail('Choose an available episode.');
          const now = new Date().toISOString();
          const result = input.revision === 0
            ? await env.DB.prepare('INSERT INTO viewer_preferences(user_id,watched_episode,revision,updated_at) VALUES(?,?,1,?) ON CONFLICT(user_id) DO NOTHING').bind(userId,input.watchedThrough,now).run()
            : await env.DB.prepare('UPDATE viewer_preferences SET watched_episode=?,revision=revision+1,updated_at=? WHERE user_id=? AND revision=?').bind(input.watchedThrough,now,userId,input.revision).run();
          if (!result.meta.changes) fail('Your watched setting changed on another device. Refresh and try again.',409);
          return json({ ...await seasonView(env.DB,input.watchedThrough), preferences: await preferences(env.DB,userId) });
        }
        if (!member) fail('Join the family league with your invite code.', 403);
        if (path === '/league' && request.method === 'GET') {
          const { settings } = await snapshot(env.DB);
          const { results } = await env.DB.prepare('SELECT m.name AS player, m.user_id, t.submitted, t.submitted_at FROM members m LEFT JOIN teams t ON t.user_id = m.user_id ORDER BY m.joined_at').all();
          const hidden = isOpen(settings);
          return json({ hidden, teams: results.map(row => ({ player: row.player, name: parse(row.submitted)?.name || row.player, submitted: !!row.submitted, submittedAt: row.submitted_at, mine: row.user_id === userId, ...(row.submitted && (!hidden || row.user_id === userId) ? { picks: parse(row.submitted).picks } : {}) })) });
        }
        if (path === '/team' && request.method === 'PUT') {
          const input = await body(request);
          const { settings, cast } = await snapshot(env.DB);
          if (!isOpen(settings)) fail('Picking is locked. Your submitted team is unchanged.', 423);
          if (!Number.isInteger(input.revision) || input.revision < 0 || typeof input.submit !== 'boolean') fail('Invalid save version.');
          const error = validateTeam(input.team, cast, { complete: input.submit });
          if (error) fail(error);
          const value = JSON.stringify({ name: input.team.name.trim(), picks: input.team.picks });
          const now = new Date().toISOString();
          // The open check and revision guard are part of the write: a concurrent lock or another device cannot be overwritten.
          const write = await env.DB.prepare(`INSERT INTO teams (user_id, draft, submitted, revision, updated_at, submitted_at)
            SELECT ?, ?, ?, 1, ?, ? WHERE ? = 0 AND EXISTS (SELECT 1 FROM league WHERE id=1 AND open=1 AND (deadline IS NULL OR julianday(deadline)>julianday('now')))
            ON CONFLICT(user_id) DO NOTHING`).bind(userId, value, input.submit ? value : null, now, input.submit ? now : null, input.revision).run();
          let changes = write.meta.changes;
          if (input.revision > 0) {
            const update = await env.DB.prepare(`UPDATE teams SET draft=?, submitted=CASE WHEN ? THEN ? ELSE submitted END,
              submitted_at=CASE WHEN ? THEN ? ELSE submitted_at END, revision=revision+1, updated_at=?
              WHERE user_id=? AND revision=? AND EXISTS (SELECT 1 FROM league WHERE id=1 AND open=1 AND (deadline IS NULL OR julianday(deadline)>julianday('now')))`)
              .bind(value, input.submit ? 1 : 0, value, input.submit ? 1 : 0, now, now, userId, input.revision).run();
            changes = update.meta.changes;
          }
          if (!changes) fail('The draft changed on another device or picking was locked. Refresh before saving again.', 409);
          return json({ team: teamModel(await env.DB.prepare('SELECT * FROM teams WHERE user_id=?').bind(userId).first()) });
        }
        if (!path.startsWith('/admin/')) fail('Not found.', 404);
        if (member.role !== 'admin') fail('Commissioner access required.', 403);
        if (path === '/admin/invite' && request.method === 'POST') {
          const bytes = crypto.getRandomValues(new Uint8Array(12));
          const code = [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
          await env.DB.prepare('UPDATE league SET invite_hash=? WHERE id=1').bind(await hash(code)).run();
          return json({ code });
        }
        if (path === '/admin/settings' && request.method === 'PUT') {
          const input = await body(request);
          if (typeof input.open !== 'boolean' || !Number.isInteger(input.revision)) fail('Invalid league settings.');
          const update = await env.DB.prepare('UPDATE league SET open=?, revision=revision+1 WHERE id=1 AND revision=?').bind(input.open ? 1 : 0, input.revision).run();
          if (!update.meta.changes) fail('League settings changed. Refresh and try again.', 409);
          await env.DB.prepare('INSERT INTO audit (user_id,action,detail) VALUES (?,?,?)').bind(userId, 'picking', input.open ? 'Picking reopened' : 'Picking locked; submitted teams revealed').run();
          return json({ settings: (await snapshot(env.DB)).settings });
        }
        if (path === '/admin/sync' && request.method === 'POST') return json(await syncResults(env));
        if (path === '/admin/sync' && request.method === 'GET') {
          const row = await env.DB.prepare('SELECT last_checked,last_success,status,error FROM sync_state WHERE id=1').first();
          return json(row);
        }
        if (path === '/admin/result' && request.method === 'PUT') {
          const input = await body(request);
          const { cast } = await snapshot(env.DB);
          const error = validateResult(input, cast);
          if (error) fail(error);
          const current = cast.find(c => c.id === input.id);
          if (!Number.isInteger(input.revision) || input.revision !== current.revision) fail('This result changed. Refresh and try again.', 409);
          const now = new Date().toISOString();
          // Unique placement index plus revision guard prevent conflicting commissioner saves.
          const write = env.DB.prepare(`INSERT INTO results(id,placement,bonuses,episode,revision,updated_at) VALUES (?,?,?,?,1,?)
            ON CONFLICT(id) DO UPDATE SET placement=excluded.placement,bonuses=excluded.bonuses,episode=excluded.episode,revision=results.revision+1,updated_at=excluded.updated_at WHERE results.revision=?`)
            .bind(input.id, input.placement, JSON.stringify(input.bonuses), input.episode, now, input.revision);
          // D1 batches are transactional. Each dependent write runs only if the
          // previous statement changed a row, preserving the revision guard.
          const writes = await env.DB.batch([
            write,
            env.DB.prepare('INSERT INTO result_history(episode,id,placement,bonuses,revision,updated_at) SELECT ?,?,?,?,?,? WHERE changes()>0 ON CONFLICT(episode,id) DO UPDATE SET placement=excluded.placement,bonuses=excluded.bonuses,revision=excluded.revision,updated_at=excluded.updated_at').bind(input.episode,input.id,input.placement,JSON.stringify(input.bonuses),input.revision+1,now),
            env.DB.prepare('UPDATE league SET last_episode=MAX(last_episode,?) WHERE id=1 AND changes()>0').bind(input.episode),
            env.DB.prepare('INSERT INTO audit(user_id,action,detail) SELECT ?,?,? WHERE changes()>0').bind(userId, 'result', JSON.stringify({ name: current.name, before: { placement: current.placement, bonuses: current.bonuses }, after: input, at: now }))
          ]);
          if (!writes[0].meta.changes) fail('This result changed. Refresh and try again.', 409);
          return json({ ok: true });
        }
        if (path === '/admin/export' && request.method === 'GET') {
          const state = await snapshot(env.DB);
          const teams = await env.DB.prepare('SELECT m.name AS player,t.draft,t.submitted,t.submitted_at FROM teams t JOIN members m ON m.user_id=t.user_id').all();
          const audit = await env.DB.prepare('SELECT action,detail,created_at FROM audit ORDER BY id DESC LIMIT 100').all();
          return json({ season: season.id, ...state, teams: teams.results.map(r => ({ ...r, draft: parse(r.draft), submitted: parse(r.submitted) })), audit: audit.results });
        }
        fail('Not found.', 404);
      } catch (error) {
        return json({ error: error.status ? error.message : 'Could not complete the request. Please try again.' }, error.status || 500);
      }
    }
  };
}
export default createWorker();
