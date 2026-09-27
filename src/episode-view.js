export const emptyBonuses = () => ({ immunityWin: 0, idolFound: 0, idolPlayed: 0 });

// A safe first render must not inherit results from the bundled premiere data.
export function preseasonCast(cast) {
  return cast.map(c => ({ ...c, tribe: 'Castaway', placement: null, bonuses: emptyBonuses(), revision: 0 }));
}

export function episodeLabel(number) {
  return number ? `Through episode ${number}` : 'Before episode 1';
}

export function projectSeason(cast, snapshots, through = 0, overrides = []) {
  const available = [...snapshots].sort((a, b) => a.number - b.number);
  const latestEpisode = Math.max(0, ...available.map(ep => ep.number), ...overrides.map(r => r.episode));
  const watchedThrough = Math.max(0, Math.min(Number.isInteger(through) ? through : 0, latestEpisode));
  const selected = available.filter(ep => ep.number <= watchedThrough).at(-1);
  const rows = new Map((selected?.cast || []).map(c => [c.id, c]));
  const visibleCast = preseasonCast(cast).map(c => ({ ...c, ...rows.get(c.id), bonuses: { ...c.bonuses, ...rows.get(c.id)?.bonuses } }));
  const corrections = new Map();
  for (const row of [...overrides].filter(r => r.episode <= watchedThrough).sort((a,b)=>a.episode-b.episode)) corrections.set(row.id,row);
  for (const row of corrections.values()) {
    const c = visibleCast.find(c => c.id === row.id);
    const atCorrection = available.filter(ep=>ep.number<=row.episode).at(-1)?.cast.find(r=>r.id===row.id);
    if (c) {
      if (row.placement !== (atCorrection?.placement ?? null)) c.placement = row.placement;
      for (const key of Object.keys(emptyBonuses())) c.bonuses[key] = Math.max(0,(c.bonuses[key] || 0) + row.bonuses[key] - (atCorrection?.bonuses[key] || 0));
      c.revision = Math.max(...overrides.filter(r=>r.id===c.id&&r.episode<=watchedThrough).map(r=>r.revision));
    }
  }
  // Only episode number/date cross the spoiler boundary. No hidden titles, names,
  // summaries, result counts, source URLs, or future score fields reach the UI.
  const episodes = Array.from({ length: latestEpisode }, (_, i) => {
    const ep = available.find(ep => ep.number === i + 1);
    if (i + 1 > watchedThrough) return { number: i + 1, date: ep?.date || null, locked: true };
    return { number: i + 1, date: ep?.date || null, title: ep?.title || `Episode ${i + 1}`, summary: ep?.summary || '', events: ep?.events || [], source: ep?.source || '', locked: false };
  });
  return { cast: visibleCast, episodes, view: { watchedThrough, latestEpisode, caughtUp: watchedThrough === latestEpisode } };
}
