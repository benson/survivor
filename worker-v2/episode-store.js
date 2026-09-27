import cast from '../data/s51/contestants.json' with { type: 'json' };
import premiere from '../data/s51/episodes.json' with { type: 'json' };
import { projectSeason } from '../src/episode-view.js';

export const seedSnapshot = { ...premiere[0], cast: cast.map(c => ({ id: c.id, placement: c.placement, bonuses: c.bonuses, tribe: c.tribe })) };

export async function episodeData(db) {
  const [episodes, history] = await Promise.all([
    db.prepare('SELECT payload FROM episode_snapshots ORDER BY episode').all(),
    db.prepare('SELECT * FROM result_history ORDER BY episode').all()
  ]);
  const snapshots = new Map([[1, seedSnapshot]]);
  for (const row of episodes.results) { const ep = JSON.parse(row.payload); snapshots.set(ep.number, ep); }
  return { snapshots: [...snapshots.values()], overrides: history.results.map(r => ({ ...r, bonuses: JSON.parse(r.bonuses) })) };
}

export async function preferences(db, userId) {
  const row = userId ? await db.prepare('SELECT * FROM viewer_preferences WHERE user_id=?').bind(userId).first() : null;
  return { watchedThrough: row?.watched_episode || 0, revision: row?.revision || 0 };
}

export async function seasonView(db, through = 0) {
  const { snapshots, overrides } = await episodeData(db);
  const [config, sync] = await Promise.all([
    db.prepare('SELECT * FROM league WHERE id=1').first(),
    db.prepare('SELECT last_checked,last_success,status FROM sync_state WHERE id=1').first()
  ]);
  const projected = projectSeason(cast, snapshots, through, overrides);
  return { ...projected, settings: { open: !!config.open, deadline: config.deadline, revision: config.revision, lastEpisode: projected.view.latestEpisode },
    updates: { status: sync?.status || 'pending', checkedAt: sync?.last_checked || null, updatedAt: sync?.last_success || null } };
}
