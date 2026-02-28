const WORKER_URL = 'https://survivor-api.brostar.workers.dev';

// --- data loading ---

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`failed to fetch ${path}`);
  return res.json();
}

let seasonsCache = null;
async function loadSeasons() {
  if (!seasonsCache) seasonsCache = await fetchJSON('data/seasons.json');
  return seasonsCache;
}

const seasonDataCache = {};
async function loadSeasonData(id, bustCache = false) {
  if (bustCache) delete seasonDataCache[id];
  if (!seasonDataCache[id]) {
    const [season, contestants, staticPicks] = await Promise.all([
      fetchJSON(`data/${id}/season.json`),
      fetchJSON(`data/${id}/contestants.json`),
      fetchJSON(`data/${id}/picks.json`)
    ]);

    // for active seasons, merge in live picks from worker
    let picks = staticPicks;
    if (season.status === 'active') {
      try {
        const res = await fetch(`${WORKER_URL}/picks/${id}`);
        if (res.ok) {
          const data = await res.json();
          if (data.picks && data.picks.length > 0) {
            // merge: worker picks override static picks by name
            const merged = new Map();
            for (const p of staticPicks) merged.set(p.name, p);
            for (const p of data.picks) merged.set(p.name, p);
            picks = Array.from(merged.values());
          }
        }
      } catch (e) {
        console.warn('worker fetch failed, using static picks:', e.message);
      }
    }

    seasonDataCache[id] = { season, contestants, picks };
  }
  return seasonDataCache[id];
}

// --- scoring engine ---

function computeStandings(season, contestants, picks) {
  const contestantMap = new Map();
  for (const c of contestants) contestantMap.set(c.name, c);
  const { contestantCount, scoring } = season;

  const results = picks.map(player => {
    const pickContestants = player.picks.map(name => contestantMap.get(name));
    const altContestants = (player.alternates || []).map(name => contestantMap.get(name));

    // placement points for a contestant
    const placementPts = c => {
      if (!c || c.placement == null) return 0;
      return contestantCount + 1 - c.placement;
    };

    // gameplay bonus points for a contestant
    const bonusPts = c => {
      if (!c || !c.bonuses) return 0;
      let total = 0;
      for (const [key, count] of Object.entries(c.bonuses)) {
        if (scoring[key]) total += count * scoring[key];
      }
      return total;
    };

    const totalPts = c => placementPts(c) + bonusPts(c);

    // find best alternate swap: replace earliest-eliminated pick with alt if net gain
    let swapIndex = -1;
    let swapAltIndex = -1;
    if (altContestants.length > 0) {
      // find the pick with lowest placement points (earliest eliminated)
      let worstIdx = -1;
      let worstPts = Infinity;
      for (let i = 0; i < pickContestants.length; i++) {
        const c = pickContestants[i];
        const pp = placementPts(c);
        // only consider eliminated contestants (placement != null) for swapping
        if (c && c.placement != null && pp < worstPts) {
          worstPts = pp;
          worstIdx = i;
        }
      }

      if (worstIdx !== -1) {
        // check each alternate
        for (let a = 0; a < altContestants.length; a++) {
          const alt = altContestants[a];
          if (totalPts(alt) > totalPts(pickContestants[worstIdx])) {
            swapIndex = worstIdx;
            swapAltIndex = a;
            break;
          }
        }
      }
    }

    // compute final picks with swap applied
    const finalPicks = pickContestants.map((c, i) => ({
      contestant: c,
      placement: placementPts(c),
      bonus: bonusPts(c),
      total: totalPts(c),
      swappedOut: i === swapIndex
    }));

    const activeAlts = altContestants.map((c, a) => ({
      contestant: c,
      placement: placementPts(c),
      bonus: bonusPts(c),
      total: totalPts(c),
      swappedIn: a === swapAltIndex
    }));

    // sum active points
    let totalPoints = 0;
    for (let i = 0; i < finalPicks.length; i++) {
      if (finalPicks[i].swappedOut) continue;
      totalPoints += finalPicks[i].total;
    }
    for (const alt of activeAlts) {
      if (alt.swappedIn) totalPoints += alt.total;
    }

    // winner/runner-up bonuses
    let winnerBonusPts = 0;
    let runnerUpBonusPts = 0;
    const activePicks = [
      ...finalPicks.filter(p => !p.swappedOut).map(p => p.contestant),
      ...activeAlts.filter(a => a.swappedIn).map(a => a.contestant)
    ];

    for (const c of activePicks) {
      if (!c) continue;
      if (c.placement === 1 && scoring.winnerBonus) {
        winnerBonusPts = scoring.winnerBonus;
      }
      if (c.placement === 2 && scoring.runnerUpBonus) {
        runnerUpBonusPts = scoring.runnerUpBonus;
      }
    }

    totalPoints += winnerBonusPts + runnerUpBonusPts;

    return {
      name: player.name,
      picks: finalPicks,
      alternates: activeAlts,
      winnerBonus: winnerBonusPts,
      runnerUpBonus: runnerUpBonusPts,
      total: totalPoints
    };
  });

  results.sort((a, b) => b.total - a.total);
  return results;
}

// --- routing ---

function getRoute() {
  const hash = location.hash.slice(1) || '/';
  const parts = hash.split('/').filter(Boolean);
  if (parts.length === 0) return { view: 'home' };
  if (parts[0] === 'submit') return { view: 'submit' };
  if (parts[0] === 'history') return { view: 'history' };
  if (parts[0] === 'season' && parts[1]) {
    if (parts[2]) return { view: 'player', seasonId: parts[1], player: decodeURIComponent(parts[2]) };
    return { view: 'season', seasonId: parts[1] };
  }
  return { view: 'home' };
}

async function router() {
  const route = getRoute();
  const app = document.getElementById('app');
  app.innerHTML = '<div class="loading">loading...</div>';

  try {
    switch (route.view) {
      case 'home': await renderHome(app); break;
      case 'submit': await renderSubmit(app); break;
      case 'season': await renderSeason(app, route.seasonId); break;
      case 'player': await renderPlayer(app, route.seasonId, route.player); break;
      case 'history': await renderHistory(app); break;
      default: app.innerHTML = '<p>not found</p>';
    }
  } catch (e) {
    console.error(e);
    app.innerHTML = `<p class="error">error loading page: ${e.message}</p>`;
  }
}

// --- views ---

async function renderHome(app) {
  const seasons = await loadSeasons();
  const active = seasons.find(s => s.status === 'active');
  if (active) {
    await renderSeason(app, active.id);
    return;
  }
  // no active season — show latest completed
  const completed = seasons.filter(s => s.status === 'completed');
  if (completed.length > 0) {
    const latest = completed[completed.length - 1];
    await renderSeason(app, latest.id);
    return;
  }
  app.innerHTML = '<p>no seasons found</p>';
}

async function renderSeason(app, seasonId) {
  const { season, contestants, picks } = await loadSeasonData(seasonId);
  const standings = computeStandings(season, contestants, picks);
  const seasons = await loadSeasons();

  const isActive = season.status === 'active';
  const now = new Date();
  const deadline = season.submissionDeadline ? new Date(season.submissionDeadline) : null;
  const submissionsOpen = isActive && deadline && now < deadline;

  let html = '';

  // nav
  html += `<nav class="season-nav">`;
  for (const s of seasons) {
    const cls = s.id === seasonId ? 'active' : '';
    html += `<a href="#/season/${s.id}" class="${cls}">${s.name}</a>`;
  }
  html += `</nav>`;

  html += `<h1>${season.name}</h1>`;
  if (isActive) {
    const eliminated = contestants.filter(c => c.placement != null).length;
    const remaining = season.contestantCount - eliminated;
    html += `<p class="subtitle">${remaining} remain &mdash; ${eliminated} eliminated</p>`;
  } else {
    html += `<p class="subtitle">final results</p>`;
  }

  // submit callout (active season, submissions open, no picks yet)
  if (submissionsOpen) {
    const deadlineStr = deadline.toLocaleDateString('en-us', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    html += `<div class="submit-callout"><a href="#/submit">submit your picks for ${season.name} &rarr;</a><span class="deadline-note">deadline: ${deadlineStr}</span></div>`;
  }

  // winner callout (completed seasons)
  if (season.status === 'completed' && standings.length > 0) {
    const winner = standings[0];
    html += `
      <div class="winner-callout">
        <span class="corner tl"></span>
        <span class="corner tr"></span>
        <span class="corner bl"></span>
        <span class="corner br"></span>
        <div class="trophy">&#x1F3C6;</div>
        <span class="winner-label">draft winner</span>
        <span class="winner-name-callout">${winner.name} &mdash; ${winner.total} pts</span>
      </div>`;
  }

  // standings table
  html += `<section><h2>standings</h2>`;
  if (picks.length > 0) {
    html += `<table class="standings"><thead><tr>
      <th class="rank-col">#</th><th>player</th><th class="pts-col">pts</th>
    </tr></thead><tbody>`;
    standings.forEach((p, i) => {
      const cls = i === 0 ? 'first-place' : '';
      html += `<tr class="${cls}">
        <td>${i + 1}</td>
        <td><a href="#/season/${seasonId}/${encodeURIComponent(p.name)}">${p.name}</a></td>
        <td>${p.total}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
  } else {
    html += `<p class="section-note">no picks submitted yet.</p>`;
  }
  html += `</section>`;

  // picks grid
  if (picks.length > 0) {
    /* only show grid when there are picks */
    html += `<section><h2>draft picks</h2>`;
    html += `<p class="section-note">alternates replace your earliest-eliminated pick if beneficial.</p>`;
    html += `<div class="picks-scroll"><table class="picks"><thead><tr><th>player</th>`;
    for (let i = 0; i < season.picksPerPlayer; i++) html += `<th>pick ${i + 1}</th>`;
    html += `<th class="alt-col">alt</th></tr></thead><tbody>`;

    for (const result of standings) {
      html += `<tr><td class="player-name">${result.name}</td>`;
      for (const pick of result.picks) {
        const c = pick.contestant;
        const name = c ? c.name.split(' ')[0] : '?';
        let cls = 'pick';
        if (pick.swappedOut) cls += ' swapped-out';
        else if (c && c.placement === 1) cls += ' winner';
        else if (c && c.placement === 2) cls += ' runner-up';
        else if (c && c.placement != null && !c.jury) cls += ' pre-jury';
        html += `<td><span class="${cls}">${thumbnail(c)}${name}`;
        if (c && c.placement != null) html += ` <span class="pts">(${pick.total})</span>`;
        html += `</span></td>`;
      }
      for (const alt of result.alternates) {
        const c = alt.contestant;
        const name = c ? c.name.split(' ')[0] : '?';
        let cls = 'pick';
        if (alt.swappedIn) cls += ' swapped-in';
        html += `<td class="alt-col"><span class="${cls}">${thumbnail(c)}${name}`;
        if (c && c.placement != null) html += ` <span class="pts">(${alt.total})</span>`;
        html += `</span></td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table></div></section>`;
  }

  // scoring rules
  html += `<section><h2>scoring</h2><div class="scoring-rules">`;
  html += `<p><b>placement points</b> &mdash; each pick earns points based on how far they got. winner = ${season.contestantCount} pts, first out = 1 pt.</p>`;
  html += `<p><b>alternate swap</b> &mdash; your alternate replaces your earliest-eliminated pick, but only if it's an upgrade.</p>`;
  html += `<p><b>bonuses</b> &mdash; +${season.scoring.winnerBonus} for picking the winner. +${season.scoring.runnerUpBonus} for picking the runner-up.</p>`;
  if (season.scoring.immunityWin) {
    html += `<p><b>gameplay</b> &mdash; +${season.scoring.immunityWin}/immunity win, +${season.scoring.idolFound}/idol found, +${season.scoring.idolPlayed}/idol played.</p>`;
  }
  html += `</div></section>`;

  // score breakdowns
  if (picks.length > 0) {
    /* only show breakdowns when there are picks */
    html += `<section><h2>score breakdowns</h2><div class="breakdowns">`;
    for (const result of standings) {
      html += `<div class="breakdown">`;
      html += `<div class="breakdown-header">${result.name} &mdash; ${result.total}</div>`;
      html += `<table class="breakdown-table">`;

      for (const pick of result.picks) {
        const c = pick.contestant;
        if (!c) continue;
        const placementStr = c.placement != null ? ordinal(c.placement) : 'active';
        const calc = pick.swappedOut ? '&larr; swapped out' : '';
        const pts = pick.swappedOut ? `<s>${pick.total}</s>` : pick.total;
        html += `<tr><td>${thumbnail(c)}${c.name.split(' ')[0]} (${placementStr})</td><td class="calc">${calc}</td><td class="bp">${pts}</td></tr>`;
      }

      for (const alt of result.alternates) {
        const c = alt.contestant;
        if (!c) continue;
        const placementStr = c.placement != null ? ordinal(c.placement) : 'active';
        if (alt.swappedIn) {
          html += `<tr><td>${thumbnail(c)}${c.name.split(' ')[0]} (${placementStr})</td><td class="calc">&larr; swapped in</td><td class="bp">${alt.total}</td></tr>`;
        } else {
          html += `<tr class="bonus-row"><td colspan="2">alt ${thumbnail(c)}${c.name.split(' ')[0]} (${placementStr}) not used</td><td class="bp">&mdash;</td></tr>`;
        }
      }

      if (result.winnerBonus > 0) {
        html += `<tr class="bonus-row"><td colspan="2">winner bonus</td><td class="bp">+${result.winnerBonus}</td></tr>`;
      }
      if (result.runnerUpBonus > 0) {
        html += `<tr class="bonus-row"><td colspan="2">runner-up bonus</td><td class="bp">+${result.runnerUpBonus}</td></tr>`;
      }
      html += `<tr class="total-row"><td colspan="2">total</td><td class="bp">${result.total}</td></tr>`;
      html += `</table></div>`;
    }
    html += `</div></section>`;
  }

  // elimination timeline
  const eliminated = contestants.filter(c => c.placement != null).sort((a, b) => b.placement - a.placement);
  if (eliminated.length > 0) {
    html += `<section><h2>elimination order</h2><ol class="timeline">`;
    let inJury = false;
    let inFinale = false;
    for (const c of eliminated) {
      let liClass = '';
      let contClass = 'contestant';

      if (c.placement <= 3 && !inFinale) {
        inFinale = true;
        liClass = 'finale-start';
      } else if (c.jury && !inJury) {
        inJury = true;
        liClass = 'jury-start';
      }

      if (c.placement === 1) contClass += ' winner-name';
      else if (c.placement <= 3) contClass += ' finalist';
      else if (c.jury) contClass += ' jury';
      else if (c.method === 'medevac') contClass += ' medevac';
      else contClass += ' pre-jury';

      html += `<li class="${liClass}">
        <span class="placement">${ordinal(c.placement)}</span>
        <span class="${contClass}">${c.name}</span>
        <span class="note">${c.note || c.method || ''}</span>
      </li>`;
    }
    html += `</ol></section>`;
  }

  app.innerHTML = html;
}

async function renderPlayer(app, seasonId, playerName) {
  const { season, contestants, picks } = await loadSeasonData(seasonId);
  const standings = computeStandings(season, contestants, picks);
  const result = standings.find(p => p.name === playerName);
  if (!result) {
    app.innerHTML = `<p>player "${playerName}" not found</p>`;
    return;
  }

  let html = `<a href="#/season/${seasonId}" class="back">&larr; back to ${season.name}</a>`;
  html += `<h1>${result.name}</h1>`;
  html += `<p class="subtitle">${result.total} points &mdash; ${season.name}</p>`;

  html += `<section><h2>breakdown</h2>`;
  html += `<div class="breakdown"><div class="breakdown-header">${result.name} &mdash; ${result.total}</div>`;
  html += `<table class="breakdown-table">`;

  for (const pick of result.picks) {
    const c = pick.contestant;
    if (!c) continue;
    const placementStr = c.placement != null ? ordinal(c.placement) : 'active';
    const calc = pick.swappedOut ? '&larr; swapped out' : '';
    html += `<tr><td>${c.name} (${placementStr})</td><td class="calc">${calc}</td><td class="bp">${pick.swappedOut ? `<s>${pick.total}</s>` : pick.total}</td></tr>`;
    if (pick.bonus > 0 && !pick.swappedOut) {
      html += `<tr class="bonus-row"><td colspan="2">&nbsp;&nbsp;gameplay bonuses</td><td class="bp">+${pick.bonus}</td></tr>`;
    }
  }
  for (const alt of result.alternates) {
    const c = alt.contestant;
    if (!c) continue;
    const placementStr = c.placement != null ? ordinal(c.placement) : 'active';
    if (alt.swappedIn) {
      html += `<tr><td>${c.name} (${placementStr})</td><td class="calc">&larr; swapped in</td><td class="bp">${alt.total}</td></tr>`;
    } else {
      html += `<tr class="bonus-row"><td colspan="2">alt ${c.name} not used</td><td class="bp">&mdash;</td></tr>`;
    }
  }
  if (result.winnerBonus > 0) html += `<tr class="bonus-row"><td colspan="2">winner bonus</td><td class="bp">+${result.winnerBonus}</td></tr>`;
  if (result.runnerUpBonus > 0) html += `<tr class="bonus-row"><td colspan="2">runner-up bonus</td><td class="bp">+${result.runnerUpBonus}</td></tr>`;
  html += `<tr class="total-row"><td colspan="2">total</td><td class="bp">${result.total}</td></tr>`;
  html += `</table></div></section>`;

  app.innerHTML = html;
}

async function renderHistory(app) {
  const seasons = await loadSeasons();
  let html = `<h1>past seasons</h1>`;
  html += `<div class="history-list">`;
  for (const s of [...seasons].reverse()) {
    html += `<a href="#/season/${s.id}" class="history-card">
      <span class="history-name">${s.name}</span>
      <span class="history-status">${s.status}</span>
    </a>`;
  }
  html += `</div>`;
  app.innerHTML = html;
}

async function renderSubmit(app) {
  const seasons = await loadSeasons();
  const active = seasons.find(s => s.status === 'active');
  if (!active) {
    app.innerHTML = '<p>no active season for pick submission</p>';
    return;
  }

  const { season, contestants } = await loadSeasonData(active.id);
  const now = new Date();
  const deadline = season.submissionDeadline ? new Date(season.submissionDeadline) : null;

  if (deadline && now >= deadline) {
    app.innerHTML = `<h1>submissions closed</h1><p class="subtitle">the deadline for ${season.name} has passed.</p><p><a href="#/" class="back">&larr; back to standings</a></p>`;
    return;
  }

  let existingNames = new Set();
  try {
    const res = await fetch(`${WORKER_URL}/picks/${season.id}`);
    if (res.ok) {
      const data = await res.json();
      if (data.picks) existingNames = new Set(data.picks.map(p => p.name));
    }
  } catch (e) {}

  const totalSlots = season.picksPerPlayer + season.alternates;
  const tribes = ['cila', 'kalo', 'vatu'];

  let html = `<a href="#/" class="back">&larr; back</a>`;
  html += `<h1>submit picks — ${season.name}</h1>`;
  if (deadline) {
    html += `<p class="subtitle">deadline: ${deadline.toLocaleDateString('en-us', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</p>`;
  }

  // name input
  html += `<div class="form-field" style="max-width:300px;margin-top:20px"><label for="player-name">your name</label><input type="text" id="player-name" required placeholder="e.g. benson"></div>`;

  // pick slots bar
  html += `<div class="pick-slots">`;
  for (let i = 0; i < season.picksPerPlayer; i++) {
    html += `<div class="pick-slot" data-slot="${i}"><span class="slot-label">pick ${i + 1}</span><span class="slot-name"></span></div>`;
  }
  for (let i = 0; i < season.alternates; i++) {
    html += `<div class="pick-slot alt-slot" data-slot="${season.picksPerPlayer + i}"><span class="slot-label">alt</span><span class="slot-name"></span></div>`;
  }
  html += `</div>`;

  // contestant grid by tribe
  for (const tribe of tribes) {
    const tribeContestants = contestants.filter(c => c.tribe === tribe);
    html += `<div class="tribe-section"><h2 class="tribe-name tribe-${tribe}">${tribe}</h2>`;
    html += `<div class="contestant-grid">`;
    for (const c of tribeContestants) {
      const firstName = c.name.split(' ')[0];
      const lastName = c.name.split(' ').slice(1).join(' ');
      html += `<button type="button" class="contestant-card tribe-${c.tribe || ''}" data-name="${c.name}">`;
      if (c.image) {
        const smallImg = c.image.replace('-1024x683', '-150x150').replace('-1024x682', '-150x150');
        html += `<div class="card-img"><img src="${smallImg}" alt="${c.name}" loading="lazy"></div>`;
      }
      html += `<div class="card-info">`;
      html += `<span class="card-name">${firstName}</span>`;
      html += `<span class="card-last">${lastName}</span>`;
      if (c.bio) html += `<span class="card-bio">${c.bio}</span>`;
      html += `</div>`;
      html += `<div class="card-check">&#10003;</div>`;
      html += `</button>`;
    }
    html += `</div></div>`;
  }

  html += `<div class="submit-bar">`;
  html += `<button type="button" id="submit-btn" class="submit-btn" disabled>submit picks</button>`;
  html += `<div id="submit-status" class="submit-status"></div>`;
  html += `</div>`;

  app.innerHTML = html;

  // --- card picker logic ---
  const selected = []; // array of contestant names, length = totalSlots
  const slots = app.querySelectorAll('.pick-slot');
  const cards = app.querySelectorAll('.contestant-card');
  const submitBtn = document.getElementById('submit-btn');

  function updateUI() {
    const selectedSet = new Set(selected);
    const full = selected.length >= totalSlots;

    // batch DOM reads, then writes
    requestAnimationFrame(() => {
      slots.forEach((slot, i) => {
        const name = selected[i] || '';
        slot.querySelector('.slot-name').textContent = name ? name.split(' ')[0] : '';
        slot.classList.toggle('filled', !!name);
      });

      cards.forEach(card => {
        const name = card.dataset.name;
        const sel = selectedSet.has(name);
        card.classList.toggle('selected', sel);
        card.classList.toggle('unavailable', !sel && full);
      });

      submitBtn.disabled = !full;
    });
  }

  cards.forEach(card => {
    card.addEventListener('click', () => {
      const name = card.dataset.name;
      const idx = selected.indexOf(name);
      if (idx !== -1) {
        selected.splice(idx, 1);
      } else if (selected.length < totalSlots) {
        selected.push(name);
      }
      updateUI();
    });
  });

  // clicking a filled slot removes that pick
  slots.forEach((slot, i) => {
    slot.addEventListener('click', () => {
      if (selected[i]) {
        selected.splice(i, 1);
        updateUI();
      }
    });
  });

  // submit handler
  submitBtn.addEventListener('click', async () => {
    const status = document.getElementById('submit-status');
    const name = document.getElementById('player-name').value.trim().toLowerCase();
    if (!name) { status.textContent = 'enter your name'; status.className = 'submit-status error'; return; }

    if (existingNames.has(name)) {
      status.textContent = `"${name}" has already submitted picks`;
      status.className = 'submit-status error';
      return;
    }

    if (selected.length < totalSlots) {
      status.textContent = `select ${totalSlots} contestants`;
      status.className = 'submit-status error';
      return;
    }

    const picks = selected.slice(0, season.picksPerPlayer);
    const alternates = selected.slice(season.picksPerPlayer);

    submitBtn.disabled = true;
    status.textContent = 'submitting...';
    status.className = 'submit-status';

    try {
      const res = await fetch(`${WORKER_URL}/picks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ season: season.id, name, picks, alternates })
      });
      if (res.ok) {
        const data = await res.json();
        status.textContent = 'picks submitted! redirecting...';
        status.className = 'submit-status success';
        delete seasonDataCache[season.id];
        setTimeout(() => { location.hash = '#/'; }, 1000);
      } else {
        let msg = 'submission failed';
        try { const data = await res.json(); msg = data.error || msg; } catch (e) {}
        status.textContent = msg;
        status.className = 'submit-status error';
        submitBtn.disabled = false;
      }
    } catch (err) {
      console.error('pick submission error:', err);
      status.textContent = 'network error — try again';
      status.className = 'submit-status error';
      submitBtn.disabled = false;
    }
  });
}

// --- helpers ---

function thumbnail(c) {
  if (!c || !c.image) return '';
  const src = c.image.replace('-1024x683', '-150x150').replace('-1024x682', '-150x150');
  const tribe = c.tribe ? ` tribe-border-${c.tribe}` : '';
  return `<img class="inline-headshot${tribe}" src="${src}" alt="">`;
}

function ordinal(n) {
  if (n == null) return '?';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// --- init ---

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', router);
