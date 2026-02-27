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

  // look for the contestant/voting history table
  // fandom wiki uses tables with class "wikitable" for contestant info
  $('table.wikitable').each((_, table) => {
    const $table = $(table);
    const headers = [];
    $table.find('tr').first().find('th').each((_, th) => {
      headers.push($(th).text().trim().toLowerCase());
    });

    // contestant table typically has "contestant" or "castaway" column and "finish" or "placement"
    const nameIdx = headers.findIndex(h => h.includes('contestant') || h.includes('castaway') || h.includes('player'));
    const finishIdx = headers.findIndex(h => h.includes('finish') || h.includes('placement') || h.includes('place'));

    if (nameIdx === -1 || finishIdx === -1) return;

    $table.find('tr').slice(1).each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length <= Math.max(nameIdx, finishIdx)) return;

      const rawName = $(cells[nameIdx]).text().trim().toLowerCase();
      const rawFinish = $(cells[finishIdx]).text().trim().toLowerCase();

      // match to existing contestant by first/last name
      let matched = null;
      for (const [name] of contestantMap) {
        if (rawName.includes(name) || name.includes(rawName) ||
            rawName.split(' ').some(part => name.includes(part) && part.length > 2)) {
          matched = name;
          break;
        }
      }

      if (!matched) return;
      const contestant = contestantMap.get(matched);

      // parse placement
      const placementMatch = rawFinish.match(/(\d+)/);
      if (placementMatch) {
        contestant.placement = parseInt(placementMatch[1]);
      }

      // detect method
      if (rawFinish.includes('sole survivor') || rawFinish.includes('winner')) {
        contestant.method = 'winner';
        contestant.placement = 1;
      } else if (rawFinish.includes('runner')) {
        contestant.method = 'runner-up';
      } else if (rawFinish.includes('medevac') || rawFinish.includes('medical')) {
        contestant.method = 'medevac';
      } else if (rawFinish.includes('quit')) {
        contestant.method = 'quit';
      } else {
        contestant.method = 'voted out';
      }
    });
  });

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

async function scrapeSeason(seasonId) {
  const seasonPath = join(ROOT, 'data', seasonId, 'season.json');
  const contestantsPath = join(ROOT, 'data', seasonId, 'contestants.json');

  const season = JSON.parse(readFileSync(seasonPath, 'utf-8'));
  const existing = JSON.parse(readFileSync(contestantsPath, 'utf-8'));

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
  return true;
}

async function main() {
  const targetId = process.argv[2];

  if (targetId) {
    await scrapeSeason(targetId);
    return;
  }

  // scrape all active seasons
  const seasons = JSON.parse(readFileSync(join(ROOT, 'data', 'seasons.json'), 'utf-8'));
  let anyChanged = false;

  for (const s of seasons) {
    if (s.status !== 'active') continue;
    const changed = await scrapeSeason(s.id);
    if (changed) anyChanged = true;
  }

  if (!anyChanged) {
    console.log('no updates found');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
