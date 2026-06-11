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

function normalizeNameText(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isEditDistanceAtMostOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;

  let edits = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }

    edits++;
    if (edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }

  return edits + (a.length - i) + (b.length - j) <= 1;
}

function contestantNameMatches(text, name) {
  const normalizedText = normalizeNameText(text);
  const tokens = normalizedText.split(/\s+/).filter(Boolean);
  const parts = normalizeNameText(name).split(/\s+/).filter(Boolean);
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ');

  if (tokens.includes(firstName)) return true;
  if (lastName.length > 2 && normalizedText.includes(lastName)) return true;

  // Handles small source/local spelling differences, such as Stephenie/Stephanie.
  return firstName.length >= 5 && tokens.some(token => isEditDistanceAtMostOne(token, firstName));
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
        if (contestantNameMatches(rowText, name)) {
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
      } else if (/second\s*runner/i.test(rawFinish)) {
        contestant.method = 'second runner-up';
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

        let matchedContestant = null;
        for (const [name, contestant] of contestantMap) {
          if (contestantNameMatches(text, name)) {
            matchedContestant = contestant;
            break;
          }
        }
        if (!matchedContestant) return;

        elimOrder++;
        matchedContestant._elimOrder = elimOrder; // always overwrite
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

function parseEpisodeGuide(html) {
  const $ = cheerio.load(html);
  const episodes = [];

  // episode guide table: rows with episode number in first cell (with rowspan)
  $('table').first().find('tr').each((_, row) => {
    const cells = $(row).find('td, th');
    if (cells.length < 5) return;

    const firstText = $(cells[0]).text().trim();
    const rowspan = parseInt($(cells[0]).attr('rowspan') || '1');

    // episode rows have a number in the first cell with a rowspan
    const epNum = parseInt(firstText);
    if (!epNum || rowspan < 2) return;

    const title = $(cells[1]).text().trim().replace(/^"|"$/g, '');
    const airDate = $(cells[2]).text().trim();

    // find eliminated cell — pattern: "Name(vote)" or "Name(no vote)"
    let eliminated = '';
    let method = '';
    cells.each((_, td) => {
      const text = $(td).text().trim();
      if (/\(\d+-\d+/.test(text) || /\(no vote\)/i.test(text)) {
        eliminated = text;
      }
      // finish column: "Nth Voted Out" or "Evacuated"
      if (/voted out|evacuated|medevac|quit/i.test(text) && /day \d/i.test(text)) {
        method = text;
      }
    });

    episodes.push({ number: epNum, title, airDate, eliminated, method });
  });

  return episodes;
}

async function fetchEpisodePage(title, contestantNames) {
  const slug = title.replace(/ /g, '_');
  try {
    const html = await fetchWikiHTML(slug);
    const $ = cheerio.load(html);

    // synopsis is in a table.cquote or blockquote containing "Episode Synopsis"
    let synopsis = '';
    $('table.cquote, blockquote').each((_, el) => {
      const text = $(el).text().trim();
      if (/episode synopsis/i.test(text) && !synopsis) {
        synopsis = text
          .replace(/\u2014\s*Episode Synopsis.*$/s, '')
          .replace(/[\u201C\u201D\u201E\u201F""\n\r]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
    });

    // extract gameplay events from confessional blocks (table.cquote)
    const events = [];
    const seen = new Set();
    const nameMap = new Map();
    for (const name of contestantNames) {
      nameMap.set(name.split(' ')[0].toLowerCase(), name);
    }

    $('table.cquote').each((_, cq) => {
      const raw = $(cq).text().trim();
      const quoteText = raw.toLowerCase();

      // identify the speaker — first name at start of confessional
      let speaker = null;
      for (const [firstName, fullName] of nameMap) {
        if (quoteText.startsWith(firstName)) { speaker = fullName; break; }
      }
      if (!speaker) return;

      // idol finds — first-person language about finding/discovering an idol
      // require "idol" as a standalone word (not "idolized" etc)
      if (/(?:found|finding|discovered).{0,40}\bidols?\b|got.{0,20}\bidols?\b|\bidols?\b.{0,40}(?:found|discovered)/i.test(quoteText)) {
        if (!seen.has(`idolFound:${speaker}`)) {
          seen.add(`idolFound:${speaker}`);
          events.push({ type: 'idolFound', player: speaker, description: 'found an idol' });
        }
      }

      // idol plays
      if (/(?:play|played|playing|use|used).{0,40}(?:hidden )?(?:immunity )?\bidols?\b|\bidols?\b.{0,40}(?:play|played|used)/i.test(quoteText)) {
        if (!seen.has(`idolPlayed:${speaker}`)) {
          seen.add(`idolPlayed:${speaker}`);
          events.push({ type: 'idolPlayed', player: speaker, description: 'played an idol' });
        }
      }

      // individual immunity wins
      if (/(?:won|winning).{0,30}individual immunity/i.test(quoteText)) {
        if (!seen.has(`immunityWin:${speaker}`)) {
          seen.add(`immunityWin:${speaker}`);
          events.push({ type: 'immunityWin', player: speaker, description: 'won individual immunity' });
        }
      }
    });

    return { synopsis, events };
  } catch (e) {
    console.log(`  could not fetch episode page "${title}": ${e.message}`);
    return { synopsis: '', events: [] };
  }
}

function computeScoreImpact(eliminated, season, contestants, picks) {
  const { contestantCount } = season;
  const contestantMap = new Map();
  for (const c of contestants) contestantMap.set(c.name, c);

  const parts = [];
  for (const name of eliminated) {
    const c = contestantMap.get(name);
    if (!c || c.placement == null) continue;
    const pts = contestantCount + 1 - c.placement;
    const owners = picks.filter(p =>
      [...p.picks, ...(p.alternates || [])].includes(name)
    ).map(p => p.name);
    if (owners.length > 0) {
      parts.push(`${name} (${ordinalStr(c.placement)}) — ${pts} pts for ${owners.join(', ')}`);
    } else {
      parts.push(`${name} (${ordinalStr(c.placement)}) — not drafted`);
    }
  }
  return parts.length > 0 ? parts.join('. ') + '.' : '';
}

async function scrapeEpisodes(seasonId, season, contestants, picks) {
  const episodesPath = join(ROOT, 'data', seasonId, 'episodes.json');
  let episodes = [];
  try { episodes = JSON.parse(readFileSync(episodesPath, 'utf-8')); } catch (e) {}

  // fetch episode guide section from season page
  const guideUrl = `https://survivor.fandom.com/api.php?action=parse&page=${encodeURIComponent(season.wikiSlug)}&format=json&prop=text&section=7`;
  let guideEpisodes = [];
  try {
    const res = await fetch(guideUrl);
    if (res.ok) {
      const data = await res.json();
      if (data.parse) guideEpisodes = parseEpisodeGuide(data.parse.text['*']);
    }
  } catch (e) {
    console.log(`${seasonId}: could not fetch episode guide: ${e.message}`);
  }

  if (guideEpisodes.length === 0) {
    console.log(`${seasonId}: no episode guide found`);
    return false;
  }

  const contestantMap = new Map();
  for (const c of contestants) contestantMap.set(c.name, c);

  let changed = false;
  for (const guide of guideEpisodes) {
    // skip TBA episodes
    if (/tba/i.test(guide.eliminated) && !guide.eliminated.match(/\(/)) continue;

    const existing = episodes.find(ep => ep.number === guide.number);

    // parse eliminated names from the guide's eliminated text
    // format: "Name(vote)" — match contestant names
    const eliminatedNames = [];
    for (const [name] of contestantMap) {
      const firstName = name.split(' ')[0];
      if (guide.eliminated.toLowerCase().includes(firstName.toLowerCase())) {
        eliminatedNames.push(name);
      }
    }

    // parse air date
    const dateMatch = guide.airDate.match(/(\w+ \d+, \d{4})/);
    const airDate = dateMatch ? new Date(dateMatch[1]).toISOString().split('T')[0] : '';

    // check if we need to fetch the episode page
    const contestantNames = Array.from(contestantMap.keys());
    const needsSummary = existing ? !existing.summary : true;
    const needsEvents = existing ? (!existing.events || existing.events.length === 0) : true;
    const needsFetch = (needsSummary || needsEvents) && guide.title;

    let pageData = { synopsis: '', events: [] };
    if (needsFetch) {
      console.log(`${seasonId}: fetching ep ${guide.number} "${guide.title}"...`);
      pageData = await fetchEpisodePage(guide.title, contestantNames);
    }

    if (existing) {
      let epChanged = false;
      if (!existing.title && guide.title) { existing.title = guide.title; epChanged = true; }
      if (!existing.airDate && airDate) { existing.airDate = airDate; epChanged = true; }
      if (!existing.summary && pageData.synopsis) { existing.summary = pageData.synopsis.toLowerCase(); epChanged = true; }
      if ((!existing.events || existing.events.length === 0) && pageData.events.length > 0) {
        existing.events = pageData.events; epChanged = true;
      }
      if ((!existing.eliminated || existing.eliminated.length === 0) && eliminatedNames.length > 0) {
        existing.eliminated = eliminatedNames; epChanged = true;
      }
      if (!existing.scoreImpact || existing.scoreImpact === '') {
        const impact = computeScoreImpact(eliminatedNames, season, contestants, picks);
        if (impact) { existing.scoreImpact = impact; epChanged = true; }
      }
      if (epChanged) changed = true;
    } else {
      const methods = eliminatedNames.map(name => {
        const c = contestantMap.get(name);
        const first = name.split(' ')[0];
        return c && c.method === 'medevac' ? `${first} evacuated` : `${first} ${c?.method || 'voted out'}`;
      });

      episodes.push({
        number: guide.number,
        title: guide.title,
        airDate,
        summary: pageData.synopsis.toLowerCase(),
        eliminated: eliminatedNames,
        method: methods.join(', '),
        events: pageData.events,
        scoreImpact: computeScoreImpact(eliminatedNames, season, contestants, picks)
      });
      changed = true;
    }
  }

  if (changed) {
    episodes.sort((a, b) => a.number - b.number);
    writeFileSync(episodesPath, JSON.stringify(episodes, null, 2) + '\n');
    console.log(`${seasonId}: updated episodes.json`);
  } else {
    console.log(`${seasonId}: episodes up to date`);
  }
  return changed;
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

  return true;
}

async function main() {
  const targetId = process.argv[2];

  if (targetId) {
    await scrapeSeason(targetId);
    await updateEpisodes(targetId);
    return;
  }

  // scrape all active seasons
  const seasons = JSON.parse(readFileSync(join(ROOT, 'data', 'seasons.json'), 'utf-8'));
  let anyChanged = false;

  for (const s of seasons) {
    if (s.status !== 'active') continue;
    const changed = await scrapeSeason(s.id);
    if (changed) anyChanged = true;
    await updateEpisodes(s.id);
  }

  if (!anyChanged) {
    console.log('no updates found');
  }
}

async function updateEpisodes(seasonId) {
  const seasonPath = join(ROOT, 'data', seasonId, 'season.json');
  const contestantsPath = join(ROOT, 'data', seasonId, 'contestants.json');
  const picksPath = join(ROOT, 'data', seasonId, 'picks.json');

  const season = JSON.parse(readFileSync(seasonPath, 'utf-8'));
  if (!season.wikiSlug) return;
  const contestants = JSON.parse(readFileSync(contestantsPath, 'utf-8'));
  let picks = [];
  try { picks = JSON.parse(readFileSync(picksPath, 'utf-8')); } catch (e) {}

  await scrapeEpisodes(seasonId, season, contestants, picks);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
