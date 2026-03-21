#!/usr/bin/env node

// scrapes survivor.fandom.com for elimination data + gameplay bonuses
// usage: node scripts/scrape.js [seasonId]
// defaults to all active seasons in data/seasons.json

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

async function fetchWikiHTML(slug) {
  const url = `https://survivor.fandom.com/api.php?action=parse&page=${encodeURIComponent(slug)}&format=json&prop=text`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`wiki fetch failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`wiki error: ${data.error.info}`);
  return data.parse.text['*'];
}

function parseContestants(html, existingContestants) {
  const $ = cheerio.load(html);
  const contestantMap = new Map();
  for (const c of existingContestants) contestantMap.set(c.name, { ...c });

  // find the contestant table — has both "contestant"/"castaway" and "finish" in headers
  $('table.wikitable').each((_, table) => {
    const $table = $(table);
    const headerText = $table.find('tr').first().text().trim().toLowerCase();
    if (!/contestant|castaway|player/.test(headerText)) return;
    if (!/finish|placement|place/.test(headerText)) return;

    // scan each data row: match contestant by name, find finish cell by pattern
    $table.find('tr').slice(1).each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 3) return;

      // collect all cell texts
      const cellTexts = [];
      cells.each((_, td) => cellTexts.push($(td).text().trim().toLowerCase()));
      const rowText = cellTexts.join(' | ');

      // match a contestant name in any cell
      let matched = null;
      for (const [name] of contestantMap) {
        const lastName = name.split(' ').slice(1).join(' ');
        if (lastName.length > 2 && rowText.includes(lastName)) {
          matched = name;
          break;
        }
      }
      if (!matched) return;

      // find the finish cell — looks for "voted out", "evacuated", "sole survivor", etc.
      const finishPattern = /voted out|evacuated|medevac|quit|sole survivor|winner|runner|eliminated|day \d/i;
      let rawFinish = '';
      for (const text of cellTexts) {
        if (finishPattern.test(text)) {
          rawFinish = text;
          break;
        }
      }
      if (!rawFinish) return;

      const contestant = contestantMap.get(matched);

      // parse ordinal placement (e.g. "1st voted out" → 1, "3rd voted out" → 3)
      // this is elimination order, not final placement — convert later
      const ordinalMatch = rawFinish.match(/(\d+)(?:st|nd|rd|th)\s*(?:voted out|eliminated)/i);
      if (ordinalMatch) {
        // ordinal is elimination order: 1st out = last place
        contestant._elimOrder = parseInt(ordinalMatch[1]);
        contestant.method = 'voted out';
      } else if (/evacuated|medevac/i.test(rawFinish)) {
        // try to infer order from "Day N" if present
        const dayMatch = rawFinish.match(/day\s*(\d+)/i);
        contestant.method = 'medevac';
        if (dayMatch) contestant._elimDay = parseInt(dayMatch[1]);
      } else if (/sole survivor|winner/i.test(rawFinish)) {
        contestant.method = 'winner';
        contestant.placement = 1;
      } else if (/runner/i.test(rawFinish)) {
        contestant.method = 'runner-up';
      } else if (/quit/i.test(rawFinish)) {
        contestant.method = 'quit';
      }
    });
  });

  // voting history table ("Voted Out" row) is the authoritative elimination order
  // it includes all eliminations (voted out, medevacs, quits) in chronological order
  $('table.wikitable').each((_, table) => {
    const $table = $(table);
    $table.find('tr').each((_, row) => {
      const firstCell = $(row).find('td, th').first().text().trim().toLowerCase();
      if (!/^voted out/.test(firstCell)) return;

      let elimOrder = 0;
      $(row).find('td, th').slice(1).each((_, td) => {
        const text = $(td).text().trim().toLowerCase();
        if (!text || text === 'tbd') return;
        elimOrder++;
        for (const [name, contestant] of contestantMap) {
          const firstName = name.split(' ')[0];
          const lastName = name.split(' ').slice(1).join(' ');
          if (text.includes(firstName) || (lastName.length > 2 && text.includes(lastName))) {
            contestant._elimOrder = elimOrder; // always overwrite
            break;
          }
        }
      });
    });
  });

  // convert elimination order to placement (1st out = last place)
  const totalContestants = existingContestants.length;
  for (const [, c] of contestantMap) {
    if (c._elimOrder) {
      c.placement = totalContestants - c._elimOrder + 1;
    }
    delete c._elimOrder;
    delete c._elimDay;
  }

  // try to scrape immunity wins from challenge results
  const immunityPattern = /individual immunity/i;
  $('table.wikitable').each((_, table) => {
    const $table = $(table);
    const caption = $table.find('caption').text() || '';
    const prevHeader = $table.prev('h2, h3').text() || '';

    if (!immunityPattern.test(caption) && !immunityPattern.test(prevHeader)) return;

    // count immunity wins per contestant
    $table.find('td').each((_, td) => {
      const text = $(td).text().trim().toLowerCase();
      // cells with contestant names that won immunity
      for (const [name, contestant] of contestantMap) {
        const firstName = name.split(' ')[0];
        if (text === firstName || text === name) {
          if (!contestant.bonuses) contestant.bonuses = {};
          contestant.bonuses.immunityWin = (contestant.bonuses.immunityWin || 0) + 1;
        }
      }
    });
  });

  // scrape idol/advantage events from page text
  const fullText = $.text().toLowerCase();
  for (const [name, contestant] of contestantMap) {
    const firstName = name.split(' ')[0];
    if (!contestant.bonuses) contestant.bonuses = {};

    // count idol finds
    const idolFoundPattern = new RegExp(`${firstName}[^.]*found[^.]*idol|${firstName}[^.]*idol[^.]*found`, 'gi');
    const idolFinds = (fullText.match(idolFoundPattern) || []).length;
    if (idolFinds > 0) contestant.bonuses.idolFound = idolFinds;

    // count idol plays
    const idolPlayedPattern = new RegExp(`${firstName}[^.]*played[^.]*idol|${firstName}[^.]*idol[^.]*played`, 'gi');
    const idolPlays = (fullText.match(idolPlayedPattern) || []).length;
    if (idolPlays > 0) contestant.bonuses.idolPlayed = idolPlays;
  }

  return Array.from(contestantMap.values());
}

function generateEpisode(seasonId, season, contestants, picks) {
  const episodesPath = join(ROOT, 'data', seasonId, 'episodes.json');
  let episodes = [];
  try { episodes = JSON.parse(readFileSync(episodesPath, 'utf-8')); } catch (e) {}

  // find eliminations not yet tracked in any episode
  const alreadyTracked = new Set();
  for (const ep of episodes) {
    for (const name of ep.eliminated) alreadyTracked.add(name);
  }
  const untracked = contestants.filter(c => c.placement != null && !alreadyTracked.has(c.name));
  if (untracked.length === 0) return false;

  // sort by placement descending (earliest eliminated first)
  untracked.sort((a, b) => b.placement - a.placement);

  // compute score impact
  const { contestantCount, scoring } = season;

  const impactParts = [];
  for (const elim of untracked) {
    const pts = contestantCount + 1 - elim.placement;
    const owners = picks.filter(p =>
      [...p.picks, ...(p.alternates || [])].includes(elim.name)
    ).map(p => p.name);
    if (owners.length > 0) {
      impactParts.push(`${elim.name} (${ordinalStr(elim.placement)}) — ${pts} pts for ${owners.join(', ')}`);
    } else {
      impactParts.push(`${elim.name} (${ordinalStr(elim.placement)}) — not drafted`);
    }
  }

  // build method string
  const methods = untracked.map(c => {
    const name = c.name.split(' ')[0];
    return c.method === 'medevac' ? `${name} evacuated` : `${name} ${c.method}`;
  });

  // air date: most recent wednesday
  const now = new Date();
  const day = now.getUTCDay();
  const daysSinceWed = (day + 4) % 7; // wednesday = 3
  const lastWed = new Date(now);
  lastWed.setUTCDate(now.getUTCDate() - daysSinceWed);
  const airDate = lastWed.toISOString().split('T')[0];

  const episode = {
    number: episodes.length + 1,
    title: "",
    airDate,
    summary: "",
    eliminated: untracked.map(c => c.name),
    method: methods.join(', '),
    events: [],
    scoreImpact: impactParts.join('. ') + '.'
  };

  episodes.push(episode);
  writeFileSync(episodesPath, JSON.stringify(episodes, null, 2) + '\n');
  console.log(`${seasonId}: added episode ${episode.number} to episodes.json`);
  return true;
}

function ordinalStr(n) {
  if (n == null) return '?';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

async function scrapeSeason(seasonId) {
  const seasonPath = join(ROOT, 'data', seasonId, 'season.json');
  const contestantsPath = join(ROOT, 'data', seasonId, 'contestants.json');
  const picksPath = join(ROOT, 'data', seasonId, 'picks.json');

  const season = JSON.parse(readFileSync(seasonPath, 'utf-8'));
  const existing = JSON.parse(readFileSync(contestantsPath, 'utf-8'));
  let picks = [];
  try { picks = JSON.parse(readFileSync(picksPath, 'utf-8')); } catch (e) {}

  if (!season.wikiSlug) {
    console.log(`${seasonId}: no wikiSlug configured, skipping`);
    return false;
  }

  console.log(`${seasonId}: fetching wiki page "${season.wikiSlug}"...`);
  const html = await fetchWikiHTML(season.wikiSlug);

  console.log(`${seasonId}: parsing contestants...`);
  const updated = parseContestants(html, existing);

  // check for changes
  const oldJson = JSON.stringify(existing);
  const newJson = JSON.stringify(updated, null, 2);
  if (JSON.stringify(JSON.parse(oldJson)) === JSON.stringify(updated)) {
    console.log(`${seasonId}: no changes`);
    return false;
  }

  writeFileSync(contestantsPath, newJson + '\n');
  console.log(`${seasonId}: updated contestants.json`);

  // generate episode recap if untracked eliminations exist
  generateEpisode(seasonId, season, updated, picks);

  return true;
}

async function main() {
  const targetId = process.argv[2];

  if (targetId) {
    await scrapeSeason(targetId);
    // also backfill episodes for any untracked eliminations
    backfillEpisodes(targetId);
    return;
  }

  // scrape all active seasons
  const seasons = JSON.parse(readFileSync(join(ROOT, 'data', 'seasons.json'), 'utf-8'));
  let anyChanged = false;

  for (const s of seasons) {
    if (s.status !== 'active') continue;
    const changed = await scrapeSeason(s.id);
    if (changed) anyChanged = true;
    // backfill episodes even if no contestant changes (catches missed episodes)
    backfillEpisodes(s.id);
  }

  if (!anyChanged) {
    console.log('no updates found');
  }
}

function backfillEpisodes(seasonId) {
  const seasonPath = join(ROOT, 'data', seasonId, 'season.json');
  const contestantsPath = join(ROOT, 'data', seasonId, 'contestants.json');
  const picksPath = join(ROOT, 'data', seasonId, 'picks.json');

  const season = JSON.parse(readFileSync(seasonPath, 'utf-8'));
  const contestants = JSON.parse(readFileSync(contestantsPath, 'utf-8'));
  let picks = [];
  try { picks = JSON.parse(readFileSync(picksPath, 'utf-8')); } catch (e) {}

  generateEpisode(seasonId, season, contestants, picks);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
