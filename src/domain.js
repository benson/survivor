export const TOTAL_PICKS = 7;
export const KEEP_PICKS = 6;
export const SCORE_RULES = { winnerBonus: 5, runnerUpBonus: 3, immunityWin: 1, idolFound: 1, idolPlayed: 1 };

export function isOpen(settings, now = Date.now()) {
  return settings.open === true && (!settings.deadline || now < Date.parse(settings.deadline));
}

export function validateTeam(team, cast, { complete = false } = {}) {
  if (!team || !Array.isArray(team.picks) || team.picks.length > TOTAL_PICKS) return 'Choose up to seven castaways.';
  if (new Set(team.picks).size !== team.picks.length) return 'Each castaway can appear only once on your team.';
  // Picking is independent of results. Everyone chooses from the same full
  // roster until the commissioner locks teams, without revealing eliminations.
  const roster = new Set(cast.map(c => c.id));
  if (team.picks.some(id => !roster.has(id))) return 'Choose people from this season’s cast.';
  if (typeof team.name !== 'string' || team.name.trim().length > 40) return 'Keep your team name under 41 characters.';
  if (complete && !team.name.trim()) return 'Give your team a name.';
  if (complete && team.picks.length !== TOTAL_PICKS) return 'Choose seven people before saving.';
  return null;
}

export function scoreCast(cast, season = {}) {
  const rules = season.scoring || SCORE_RULES;
  const count = season.contestantCount || cast.length;
  const eliminated = cast.filter(c => c.placement != null).length;
  const floor = eliminated && eliminated < count ? eliminated + 1 : 0;
  return cast.map(c => {
    const placementPoints = c.placement == null ? floor : count + 1 - c.placement;
    const gameplayPoints = ['immunityWin', 'idolFound', 'idolPlayed'].reduce((n, key) => n + (c.bonuses?.[key] || 0) * (rules[key] || 0), 0);
    const finalistPoints = c.placement === 1 ? rules.winnerBonus || 0 : c.placement === 2 ? rules.runnerUpBonus || 0 : 0;
    return { ...c, placementPoints, gameplayPoints, finalistPoints, total: placementPoints + gameplayPoints + finalistPoints };
  });
}

export function standings(cast, teams, season = {}) {
  const scores = new Map(scoreCast(cast, season).map(c => [c.id || c.name, c]));
  const rows = teams.map(team => {
    const picks = [...new Set([...(team.picks || []), ...(team.alternates || [])])].map(id => scores.get(id)).filter(Boolean)
      .sort((a, b) => b.total - a.total || (a.id || a.name).localeCompare(b.id || b.name))
      .map((c, i) => ({ ...c, dropped: i >= (season.picksPerPlayer || KEEP_PICKS) }));
    return { ...team, scored: picks, total: picks.filter(c => !c.dropped).reduce((sum, c) => sum + c.total, 0), remaining: picks.filter(c => c.placement == null).length };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return rows.map((row, i) => ({ ...row, rank: i && rows[i - 1].total === row.total ? rows.findIndex(r => r.total === row.total) + 1 : i + 1 }));
}

export function validateResult(result, cast) {
  if (!result || !cast.some(c => c.id === result.id)) return 'Choose a castaway.';
  if (result.placement !== null && (!Number.isInteger(result.placement) || result.placement < 1 || result.placement > cast.length)) return 'Enter a valid finishing place.';
  if (result.placement !== null && cast.some(c => c.id !== result.id && c.placement === result.placement)) return 'That finishing place is already assigned.';
  for (const key of ['immunityWin', 'idolFound', 'idolPlayed']) {
    if (!Number.isInteger(result.bonuses?.[key]) || result.bonuses[key] < 0 || result.bonuses[key] > 30) return 'Bonus counts must be whole numbers from 0 to 30.';
  }
  if (!Number.isInteger(result.episode) || result.episode < 1 || result.episode > 30) return 'Enter an episode from 1 to 30.';
  return null;
}
