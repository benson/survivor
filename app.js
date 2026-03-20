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
            // normalize curly quotes to straight for consistent matching
            const norm = s => s.replace(/[\u2018\u2019\u201C\u201D]/g, c =>
              c === '\u2018' || c === '\u2019' ? "'" : '"');
            const merged = new Map();
            for (const p of staticPicks) merged.set(norm(p.name), p);
            for (const p of data.picks) merged.set(norm(p.name), p);
            picks = Array.from(merged.values());
          }
        }
      } catch (e) {
        console.warn('worker fetch failed, using static picks:', e.message);
      }
    }

    // load episodes if available
    let episodes = [];
    try { episodes = await fetchJSON(`data/${id}/episodes.json`); } catch (e) {}

    seasonDataCache[id] = { season, contestants, picks, episodes };
  }
  return seasonDataCache[id];
}

// --- scoring engine ---

function computeStandings(season, contestants, picks) {
  const contestantMap = new Map();
  for (const c of contestants) contestantMap.set(c.name, c);
  const { contestantCount, scoring } = season;

  // active contestants get a floor score: the minimum they're guaranteed
  // (as if they were the very next person eliminated)
  const eliminatedCount = contestants.filter(c => c.placement != null).length;
  const activeFloor = eliminatedCount > 0 ? eliminatedCount + 1 : 0;

  const results = picks.map(player => {
    const allNames = [...player.picks, ...(player.alternates || [])];
    const allContestants = allNames.map(name => contestantMap.get(name));

    const placementPts = c => {
      if (!c) return 0;
      if (c.placement != null) return contestantCount + 1 - c.placement;
      return activeFloor;
    };

    const bonusPts = c => {
      if (!c || !c.bonuses) return 0;
      let total = 0;
      for (const [key, count] of Object.entries(c.bonuses)) {
        if (scoring[key]) total += count * scoring[key];
      }
      return total;
    };

    const totalPts = c => placementPts(c) + bonusPts(c);

    // score all picks
    const scored = allContestants.map(c => ({
      contestant: c,
      placement: placementPts(c),
      bonus: bonusPts(c),
      total: totalPts(c),
      dropped: false
    }));

    // drop the lowest scorer (pick 7, keep best 6)
    if (scored.length > season.picksPerPlayer) {
      let lowestIdx = 0;
      for (let i = 1; i < scored.length; i++) {
        if (scored[i].total < scored[lowestIdx].total) lowestIdx = i;
      }
      scored[lowestIdx].dropped = true;
    }

    // sum non-dropped
    let totalPoints = 0;
    for (const s of scored) {
      if (!s.dropped) totalPoints += s.total;
    }

    // winner/runner-up bonuses
    let winnerBonusPts = 0;
    let runnerUpBonusPts = 0;
    for (const s of scored) {
      if (s.dropped || !s.contestant) continue;
      if (s.contestant.placement === 1 && scoring.winnerBonus) winnerBonusPts = scoring.winnerBonus;
      if (s.contestant.placement === 2 && scoring.runnerUpBonus) runnerUpBonusPts = scoring.runnerUpBonus;
    }
    totalPoints += winnerBonusPts + runnerUpBonusPts;

    return {
      name: player.name,
      picks: scored,
      winnerBonus: winnerBonusPts,
      runnerUpBonus: runnerUpBonusPts,
      total: totalPoints
    };
  });

  results.sort((a, b) => b.total - a.total);
  return { standings: results, activeFloor };
}

// --- routing ---

function getRoute() {
  const hash = location.hash.slice(1) || '/';
  const parts = hash.split('/').filter(Boolean);
  if (parts.length === 0) return { view: 'home' };
  if (parts[0] === 'submit') return { view: 'submit' };
  if (parts[0] === 'history') return { view: 'history' };
  if (parts[0] === 'season' && parts[1]) {
    if (parts[2] === 'episodes') return { view: 'episodes', seasonId: parts[1] };
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
      case 'episodes': await renderEpisodes(app, route.seasonId); break;
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
  const { season, contestants, picks, episodes } = await loadSeasonData(seasonId);
  const { standings, activeFloor } = computeStandings(season, contestants, picks);
  const seasons = await loadSeasons();

  const isActive = season.status === 'active';
  const now = new Date();
  const deadline = season.submissionDeadline ? new Date(season.submissionDeadline) : null;
  const submissionsOpen = isActive && season.submissionsOpen !== false && (!deadline || now < deadline);

  let html = '';

  // nav
  html += `<nav class="season-nav">`;
  for (const s of seasons) {
    const cls = s.id === seasonId ? 'active' : '';
    html += `<a href="#/season/${s.id}" class="${cls}">${s.name}</a>`;
  }
  html += `<a href="#/history" class="history-link">history</a>`;
  html += `</nav>`;

  html += `<h1>${season.name}</h1>`;
  if (isActive) {
    const eliminated = contestants.filter(c => c.placement != null).length;
    const remaining = season.contestantCount - eliminated;
    if (eliminated === 0) {
      html += `<p class="subtitle">${season.contestantCount} contestants</p>`;
    } else {
      html += `<p class="subtitle">${remaining} remain &mdash; ${eliminated} eliminated</p>`;
    }
  } else {
    html += `<p class="subtitle">final results</p>`;
  }

  // submit callout (active season, submissions open, no picks yet)
  if (submissionsOpen) {
    html += `<div class="submit-callout"><a href="#/submit">submit your picks for ${season.name} &rarr;</a>`;
    if (deadline) {
      const deadlineStr = deadline.toLocaleDateString('en-us', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
      html += `<span class="deadline-note">deadline: ${deadlineStr}</span>`;
    }
    html += `</div>`;
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

  // episode recap link
  if (episodes.length > 0) {
    html += `<div class="episodes-link"><a href="#/season/${seasonId}/episodes">episode recaps &rarr;</a></div>`;
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

  // picks cards
  if (picks.length > 0) {
    html += `<section><h2>draft picks</h2>`;
    html += `<p class="section-note">pick ${season.picksPerPlayer + (season.alternates || 0)}, keep your best ${season.picksPerPlayer}. lowest scorer is dropped.</p>`;
    html += `<div class="picks-grid">`;

    for (const result of standings) {
      html += `<div class="pick-card">`;
      html += `<div class="pick-card-header"><span>${result.name}</span><span class="pick-card-pts">${result.total} pts</span></div>`;
      html += `<div class="pick-card-picks">`;

      // sort: active alphabetically, then eliminated, then dropped last
      const sorted = [...result.picks].sort((a, b) => {
        if (a.dropped !== b.dropped) return a.dropped ? 1 : -1;
        const aElim = a.contestant && a.contestant.placement != null;
        const bElim = b.contestant && b.contestant.placement != null;
        if (aElim !== bElim) return aElim ? 1 : -1;
        const aName = a.contestant ? a.contestant.name : '';
        const bName = b.contestant ? b.contestant.name : '';
        return aName.localeCompare(bName);
      });

      for (const pick of sorted) {
        const c = pick.contestant;
        const name = c ? c.name.split(' ')[0] : '?';
        let cls = 'pick-card-row';
        if (c && c.placement != null) cls += ' eliminated';
        if (pick.dropped) cls += ' dropped';
        const ptsCls = c && c.placement == null ? 'pick-card-pts-val projected' : 'pick-card-pts-val';
        const ptsVal = c && c.placement != null ? pick.total : (c && pick.total > 0 ? pick.total + '+' : '');
        html += `<div class="${cls}">${thumbnail(c)}<span class="pick-card-name">${name}</span><span class="${ptsCls}">${ptsVal}</span></div>`;
      }

      html += `</div></div>`;
    }
    html += `</div></section>`;
  }

  // scoring rules
  html += `<section><h2>scoring</h2><div class="scoring-rules">`;
  html += `<p><b>placement points</b> &mdash; each pick earns points based on how far they got. winner = ${season.contestantCount} pts, first out = 1 pt.${activeFloor > 0 ? ` active picks are guaranteed at least ${activeFloor} pts.` : ''}</p>`;
  html += `<p><b>drop lowest</b> &mdash; pick ${season.picksPerPlayer + (season.alternates || 0)}, keep your best ${season.picksPerPlayer}. your lowest scorer doesn't count.</p>`;
  html += `<p><b>bonuses</b> &mdash; +${season.scoring.winnerBonus} for picking the winner. +${season.scoring.runnerUpBonus} for picking the runner-up.</p>`;
  if (season.scoring.immunityWin) {
    html += `<p><b>gameplay</b> &mdash; +${season.scoring.immunityWin}/immunity win, +${season.scoring.idolFound}/idol found, +${season.scoring.idolPlayed}/idol played.</p>`;
  }
  html += `</div></section>`;

  // score breakdowns
  if (picks.length > 0) {
    html += `<section><h2>score breakdowns</h2><div class="breakdowns">`;
    for (const result of standings) html += renderBreakdownTable(result, activeFloor);
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

async function renderEpisodes(app, seasonId) {
  const { season, contestants, picks, episodes } = await loadSeasonData(seasonId);
  const contestantMap = new Map();
  for (const c of contestants) contestantMap.set(c.name, c);

  let html = `<a href="#/season/${seasonId}" class="back">&larr; back to ${season.name}</a>`;
  html += `<h1>episode recaps</h1>`;
  html += `<p class="subtitle">${season.name}</p>`;

  for (const ep of episodes) {
    const date = new Date(ep.airDate + 'T00:00:00').toLocaleDateString('en-us', { month: 'short', day: 'numeric' });
    html += `<div class="episode-card">`;
    html += `<div class="episode-header">`;
    html += `<span class="episode-number">episode ${ep.number}</span>`;
    html += `<span class="episode-title">"${ep.title}"</span>`;
    html += `<span class="episode-date">${date}</span>`;
    html += `</div>`;
    html += `<p class="episode-summary">${ep.summary}</p>`;

    if (ep.eliminated.length > 0) {
      html += `<div class="episode-eliminated">`;
      for (const name of ep.eliminated) {
        const c = contestantMap.get(name);
        html += `<span class="episode-elim">${thumbnail(c)}${name}</span>`;
      }
      html += `<span class="episode-method">${ep.method}</span>`;
      html += `</div>`;
    }

    if (ep.events && ep.events.length > 0) {
      html += `<div class="episode-events">`;
      for (const ev of ep.events) {
        const c = contestantMap.get(ev.player);
        const icon = ev.type === 'idolFound' ? '&#x1F48E;' : ev.type === 'idolPlayed' ? '&#x1F6E1;' : ev.type === 'immunityWin' ? '&#x1F3C6;' : '&#x26A1;';
        const scorePts = season.scoring[ev.type] ? `<span class="event-pts">+${season.scoring[ev.type]}</span>` : '';
        html += `<div class="episode-event"><span class="event-icon">${icon}</span>${thumbnail(c)}<span class="event-player">${ev.player}</span><span class="event-desc">${ev.description}</span>${scorePts}</div>`;
      }
      html += `</div>`;
    }

    html += `<div class="episode-impact">${ep.scoreImpact}</div>`;
    html += `</div>`;
  }

  app.innerHTML = html;
}

async function renderPlayer(app, seasonId, playerName) {
  const { season, contestants, picks } = await loadSeasonData(seasonId);
  const { standings, activeFloor } = computeStandings(season, contestants, picks);
  const result = standings.find(p => p.name === playerName);
  if (!result) {
    app.innerHTML = `<a href="#/season/${seasonId}" class="back">&larr; back to ${season.name}</a><p>player "${playerName}" not found</p>`;
    return;
  }

  let html = `<a href="#/season/${seasonId}" class="back">&larr; back to ${season.name}</a>`;
  html += `<h1>${result.name}</h1>`;
  html += `<p class="subtitle">${result.total} points &mdash; ${season.name}</p>`;

  html += `<section><h2>breakdown</h2>`;
  html += renderBreakdownTable(result, activeFloor, { showFullName: true });
  html += `</section>`;

  app.innerHTML = html;
}

async function renderHistory(app) {
  const seasons = await loadSeasons();
  let html = `<a href="#/" class="back">&larr; back</a>`;
  html += `<h1>past seasons</h1>`;
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

  if (season.submissionsOpen === false || (deadline && now >= deadline)) {
    app.innerHTML = `<h1>submissions closed</h1><p class="subtitle">submissions for ${season.name} are closed.</p><p><a href="#/" class="back">&larr; back to standings</a></p>`;
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
  const tribes = [...new Set(contestants.map(c => c.tribe).filter(Boolean))];

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

  // submit handler — show confirmation first
  submitBtn.addEventListener('click', () => {
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

    // show confirmation overlay
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    let confirmHTML = `<div class="confirm-box">`;
    confirmHTML += `<h2>confirm your picks</h2>`;
    confirmHTML += `<p class="confirm-name">${name}</p>`;
    confirmHTML += `<ol class="confirm-picks">`;
    for (const p of picks) {
      const c = contestants.find(x => x.name === p);
      confirmHTML += `<li>${thumbnail(c)}${p}</li>`;
    }
    confirmHTML += `</ol>`;
    if (alternates.length > 0) {
      confirmHTML += `<p class="confirm-alt-label">alternate</p>`;
      for (const a of alternates) {
        const c = contestants.find(x => x.name === a);
        confirmHTML += `<p class="confirm-alt">${thumbnail(c)}${a}</p>`;
      }
    }
    confirmHTML += `<div class="confirm-buttons">`;
    confirmHTML += `<button type="button" class="confirm-go">submit</button>`;
    confirmHTML += `<button type="button" class="confirm-cancel">go back</button>`;
    confirmHTML += `</div>`;
    confirmHTML += `<div class="confirm-status"></div>`;
    confirmHTML += `</div>`;
    overlay.innerHTML = confirmHTML;
    document.body.appendChild(overlay);

    overlay.querySelector('.confirm-cancel').addEventListener('click', () => overlay.remove());

    overlay.querySelector('.confirm-go').addEventListener('click', async () => {
      const goBtn = overlay.querySelector('.confirm-go');
      const cStatus = overlay.querySelector('.confirm-status');
      goBtn.disabled = true;
      cStatus.textContent = 'submitting...';

      try {
        const res = await fetch(`${WORKER_URL}/picks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ season: season.id, name, picks, alternates })
        });
        if (res.ok) {
          cStatus.textContent = 'picks submitted!';
          cStatus.className = 'confirm-status success';
          delete seasonDataCache[season.id];
          setTimeout(() => { overlay.remove(); location.hash = '#/'; }, 1200);
        } else {
          let msg = 'submission failed';
          try { const data = await res.json(); msg = data.error || msg; } catch (e) {}
          cStatus.textContent = msg;
          cStatus.className = 'confirm-status error';
          goBtn.disabled = false;
        }
      } catch (err) {
        console.error('pick submission error:', err);
        cStatus.textContent = 'network error — try again';
        cStatus.className = 'confirm-status error';
        goBtn.disabled = false;
      }
    });
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

function renderBreakdownTable(result, activeFloor, { showFullName = false } = {}) {
  let html = `<div class="breakdown">`;
  html += `<div class="breakdown-header">${result.name} &mdash; ${result.total}</div>`;
  html += `<table class="breakdown-table">`;

  for (const pick of result.picks) {
    const c = pick.contestant;
    if (!c) continue;
    const isActive = c.placement == null;
    const name = showFullName ? c.name : c.name.split(' ')[0];
    const placementStr = isActive ? 'active' : ordinal(c.placement);
    const calc = pick.dropped ? 'dropped' : (isActive ? `${activeFloor}+ min` : '');
    let trCls = '';
    if (pick.dropped) trCls = ' class="dropped-row"';
    else if (isActive) trCls = ' class="projected-row"';
    else if (c.placement != null) trCls = ' class="eliminated-row"';
    html += `<tr${trCls}><td>${thumbnail(c)}${name} (${placementStr})</td><td class="calc">${calc}</td><td class="bp">${pick.total}${isActive ? '+' : ''}</td></tr>`;
    if (showFullName && pick.bonus > 0 && !pick.dropped) {
      html += `<tr class="bonus-row"><td colspan="2">&nbsp;&nbsp;gameplay bonuses</td><td class="bp">+${pick.bonus}</td></tr>`;
    }
  }

  if (result.winnerBonus > 0) html += `<tr class="bonus-row"><td colspan="2">winner bonus</td><td class="bp">+${result.winnerBonus}</td></tr>`;
  if (result.runnerUpBonus > 0) html += `<tr class="bonus-row"><td colspan="2">runner-up bonus</td><td class="bp">+${result.runnerUpBonus}</td></tr>`;
  html += `<tr class="total-row"><td colspan="2">total</td><td class="bp">${result.total}</td></tr>`;
  html += `</table></div>`;
  return html;
}

// --- init ---

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', router);
