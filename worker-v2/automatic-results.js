import cast from '../data/s51/contestants.json' with { type: 'json' };
import sourceIds from './cast-source-ids.json' with { type: 'json' };
import { preseasonCast } from '../src/episode-view.js';

export const SOURCE = 'https://github.com/doehm/survivoR';
export const DATASETS = ['episodes', 'castaways', 'challenge_results', 'advantage_details', 'advantage_movement', 'boot_mapping'];
const assert = (ok, message) => { if (!ok) throw new Error(message); };
export function easternTime(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
export const scheduledHour = now => [8, 12, 16].includes(easternTime(now).hour);

// This adapter consumes factual, structured records, not recap prose or guesses.
// Every dataset is fetched at one immutable upstream commit before publishing.
export function compileEpisodes(input, now = new Date()) {
  const data = Object.fromEntries(DATASETS.map(key => {
    assert(Array.isArray(input[key]), `Missing dataset: ${key}`);
    return [key, input[key].filter(r => r.version === 'US' && r.season === 51)];
  }));
  const ids = new Set(data.castaways.map(c => c.castaway_id));
  assert(ids.size === cast.length && Object.keys(sourceIds).every(id => ids.has(id)), 'Source cast does not match the season');
  const sourceCast = new Map(data.castaways.map(c => [c.castaway_id, c]));
  const local = id => { assert(sourceIds[id], 'Unknown source contestant'); return sourceIds[id]; };
  const eligible = data.episodes.filter(e => Number.isInteger(e.episode) && e.episode > 0 && e.episode <= 30 && /^\d{4}-\d{2}-\d{2}$/.test(e.episode_date) && e.episode_date < easternTime(now).date).sort((a, b) => a.episode - b.episode);
  assert(eligible.length > 0, 'No aired episodes available');
  assert(eligible.every((e, i) => e.episode === i + 1), 'Episode history is incomplete');
  const snapshot = preseasonCast(cast), snapshots = [];
  const advantages = new Map(data.advantage_details.map(a => [a.advantage_id, a.advantage_type]));
  const seenChallenges = new Set(), seenMoves = new Set();
  for (const ep of eligible) {
    const number = ep.episode, events = [];
    assert(typeof ep.episode_title === 'string' && ep.episode_title.length < 200, 'Episode title missing');
    const challengeRows = data.challenge_results.filter(r => r.episode === number);
    const tribeRows = data.boot_mapping.filter(r => r.episode === number).sort((a,b) => (a.n_boots || 0) - (b.n_boots || 0));
    assert(challengeRows.length > 0 && tribeRows.length > 0, `Episode ${number} is awaiting scoring data`);
    const mapped = new Set(tribeRows.map(r => local(r.castaway_id)));
    assert(snapshot.filter(c => c.placement === null).every(c => mapped.has(c.id)), `Episode ${number} has incomplete cast coverage`);
    for (const row of tribeRows) {
      const c = snapshot.find(c => c.id === local(row.castaway_id));
      assert(typeof row.tribe === 'string' && row.tribe.length < 60, 'Invalid tribe record');
      c.tribe = row.tribe === 'No Tribe' ? (/exile/i.test(row.game_status || '') ? 'Exile' : 'Castaway') : row.tribe;
    }
    const bonus = (id, type, description) => {
      const c = snapshot.find(c => c.id === local(id));
      c.bonuses[type]++;
      assert(c.bonuses[type] <= 30, 'Unexpected bonus count');
      events.push({ player: c.name, type, description, points: 1 });
    };
    for (const r of challengeRows) {
      local(r.castaway_id);
      assert([0, 1].includes(r.won_individual_immunity), 'Individual immunity result is incomplete');
      const key = `${number}:${r.challenge_id}:${r.castaway_id}`;
      assert(r.challenge_id != null && !seenChallenges.has(key), 'Duplicate challenge result');
      seenChallenges.add(key);
      if (r.won_individual_immunity === 1) bonus(r.castaway_id, 'immunityWin', 'Wins individual immunity.');
    }
    for (const r of data.advantage_movement.filter(r => r.episode === number)) {
      const type = advantages.get(r.advantage_id);
      assert(type, 'Advantage details are not available yet');
      if (!['Hidden Immunity Idol', 'Immunity Idol'].includes(type)) {
        assert(!/idol/i.test(type) || /nullifier|fake/i.test(type), 'Unrecognized idol type needs review');
        continue;
      }
      const key = `${r.advantage_id}:${r.sequence_id}`;
      assert(r.sequence_id != null && !seenMoves.has(key), 'Duplicate idol event');
      seenMoves.add(key);
      if (r.event === 'Found') bonus(r.castaway_id, 'idolFound', 'Finds a hidden immunity idol.');
      if (r.event === 'Played') bonus(r.castaway_id, 'idolPlayed', 'Plays a hidden immunity idol.');
    }
    for (const [id, r] of sourceCast) {
      if (r.episode !== number || r.place == null) continue;
      assert(Number.isInteger(r.place) && r.place >= 1 && r.place <= cast.length, 'Invalid finishing place');
      const c = snapshot.find(c => c.id === local(id));
      c.placement = r.place;
      events.push({ player: c.name, type: 'placement', description: `Finishes in place ${r.place}.`, points: cast.length + 1 - r.place });
    }
    const placed = snapshot.filter(c => c.placement !== null);
    assert(new Set(placed.filter(c=>c.placement>3).map(c=>c.placement)).size === placed.filter(c=>c.placement>3).length, 'Conflicting finishing places');
    assert(placed.every(c=>c.placement<=3 || c.placement > cast.length-placed.length), 'Elimination order is incomplete');
    snapshots.push({ number, date: ep.episode_date, title: ep.episode_title, summary: '', events, source: SOURCE, cast: snapshot.map(c => ({ id: c.id, tribe: c.tribe, placement: c.placement, bonuses: { ...c.bonuses } })) });
  }
  return snapshots;
}

async function fetchJSON(url, fetcher) {
  const response = await fetcher(url, { headers: { Accept: 'application/json', 'User-Agent': 'PerryFamilySurvivor/1.0' }, signal: AbortSignal.timeout(20000) });
  assert(response.ok, `Source returned ${response.status}`);
  const text = await response.text();
  assert(text.length < 20_000_000, 'Source response is too large');
  return JSON.parse(text);
}

export async function downloadResults(fetcher = fetch) {
  const commit = await fetchJSON('https://api.github.com/repos/doehm/survivoR/commits/master', fetcher);
  assert(/^[a-f0-9]{40}$/.test(commit.sha), 'Invalid source revision');
  const input = {};
  // Sequential parsing keeps peak memory bounded in the Worker.
  for (const name of DATASETS) {
    const rows = await fetchJSON(`https://raw.githubusercontent.com/doehm/survivoR/${commit.sha}/dev/json/${name}.json`, fetcher);
    assert(Array.isArray(rows), 'Invalid source data');
    input[name] = rows.filter(r => r.version === 'US' && r.season === 51);
  }
  return { input, revision: commit.sha };
}

export async function syncResults(env, { now = new Date(), fetcher = fetch } = {}) {
  const db = env.DB, at = now.toISOString();
  const lease = await db.prepare("UPDATE sync_state SET lease_until=? WHERE id=1 AND (lease_until IS NULL OR lease_until<?)").bind(new Date(+now + 300000).toISOString(), at).run();
  if (!lease.meta.changes) return { status: 'busy' };
  try {
    const { input, revision } = await downloadResults(fetcher);
    const episodes = compileEpisodes(input, now);
    const previous = await db.prepare('SELECT * FROM sync_state WHERE id=1').first();
    const published = await db.prepare('SELECT MAX(episode) AS latest FROM episode_snapshots').first();
    assert(episodes.at(-1).number >= (published.latest || 1), 'Source is older than published results');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(episodes))))].map(n => n.toString(16).padStart(2, '0')).join('');
    const changed = digest !== previous.content_hash;
    const writes = changed ? episodes.map(ep => db.prepare('INSERT INTO episode_snapshots(episode,payload,source_revision,updated_at) VALUES(?,?,?,?) ON CONFLICT(episode) DO UPDATE SET payload=excluded.payload,source_revision=excluded.source_revision,updated_at=excluded.updated_at').bind(ep.number, JSON.stringify(ep), revision, at)) : [];
    writes.push(db.prepare("UPDATE sync_state SET last_checked=?,last_success=?,source_revision=?,content_hash=?,status='current',error=NULL,lease_until=NULL WHERE id=1").bind(at, at, revision, digest));
    writes.push(db.prepare('UPDATE league SET last_episode=MAX(last_episode,?) WHERE id=1').bind(episodes.at(-1).number));
    if (changed) writes.push(db.prepare('INSERT INTO audit(user_id,action,detail) VALUES(?,?,?)').bind('automatic', 'episode-sync', JSON.stringify({ through: episodes.at(-1).number, source: SOURCE, revision })));
    await db.batch(writes);
    return { status: 'current', changed, through: episodes.at(-1).number, checkedAt: at };
  } catch (error) {
    // Retain every published snapshot on any source outage or validation failure.
    await db.prepare("UPDATE sync_state SET last_checked=?,status='retrying',error=?,lease_until=NULL WHERE id=1").bind(at, String(error.message).slice(0,300)).run();
    return { status: 'retrying', checkedAt: at };
  }
}
