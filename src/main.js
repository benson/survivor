import { CONFIG } from './config.js';
import { initAuth } from './auth.js';
import { icon, torch } from './icons.js';
import { isOpen, standings, validateTeam } from './domain.js';

const app = document.querySelector('#app'), modal = document.querySelector('#modal');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = { cast: [], season: null, episodes: [], settings: { open: true, deadline: null }, auth: null, user: null, member: null, team: {revision: 0}, league: {teams:[],hidden:true}, draft: {name:'',picks:[]}, filter:'All', search:'', selectedOnly:false, online:null, authError:'', syncing:false };
let toastTimer, authUserId, routeGeneration = 0, loaded = false;
const route = () => location.hash.slice(2).split(/[/?]/)[0] || 'camp';
const localKey = () => `survivor:s51:${state.user?.id || 'guest'}`;
function localRead(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function remember() {
  try { localStorage.setItem(localKey(), JSON.stringify({...state.draft, savedAt:Date.now(), baseRevision:state.team.revision})); }
  catch { toast('Your browser could not save this draft. Use Save draft to keep it online.'); }
}
function toast(message) {
  clearTimeout(toastTimer); const el = document.querySelector('#toast'); el.textContent = message; el.classList.add('visible');
  toastTimer = setTimeout(() => el.classList.remove('visible'), 5000);
}
async function api(path, options = {}, publicRequest = false) {
  const token = publicRequest ? null : await state.auth?.token();
  const response = await fetch(CONFIG.api + path, {...options, signal:AbortSignal.timeout(15000), headers:{'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {}), ...options.headers}});
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Could not connect. Please try again.'),{status:response.status});
  return data;
}
async function refresh({renderAfter = true} = {}) {
  try { Object.assign(state, await api('/season', {}, true)); state.online = true; }
  catch { state.online = false; }
  if (state.user) {
    try {
      const me = await api('/me'); state.member = me.member;
      const dirty = JSON.stringify(state.draft) !== JSON.stringify(state.team.draft || {name:'',picks:[]});
      if (state.team.revision && me.team?.revision !== state.team.revision && dirty && open()) {
        toast('Your team changed on another device. Reload to use the saved version.');
      } else state.team = me.team || {revision:0};
      if (!open() && state.team.submitted) state.draft = structuredClone(state.team.submitted);
      state.league = me.member ? await api('/league') : {teams:[],hidden:true};
    } catch (error) { state.online = false; toast(error.message); }
  }
  if (renderAfter) render();
}
function loadDraft() {
  const stored = localRead(localKey()), server = state.team.draft || state.team.submitted;
  const guest = !stored && !server && state.user ? localRead('survivor:s51:guest') : null;
  let draft = stored && (stored.baseRevision || 0) === state.team.revision && (!server || stored.savedAt > Date.parse(state.team.updatedAt || 0)) ? stored : server || guest || {name:'',picks:[]};
  if (!open() && state.team.submitted) draft = state.team.submitted;
  state.draft = {name: typeof draft.name === 'string' ? draft.name : '', picks: Array.isArray(draft.picks) ? draft.picks.filter(id=>state.cast.some(c=>c.id===id)).slice(0,7) : []};
}
async function authChanged(user) {
  if (!loaded || !state.auth || authUserId === (user?.id || null)) return;
  authUserId = user?.id || null; state.user = user; state.member = null; state.team = {revision:0}; state.league = {teams:[],hidden:true};
  await refresh({renderAfter:false}); loadDraft(); render();
}
function button(text, action, cls='button', extra='') {return `<button class="${cls}" data-action="${action}" ${extra}>${text}</button>`;}
function link(text, view, cls='button') {return `<a class="${cls}" href="#/${view}">${text}</a>`;}
function image(c, cls='') {return `<img class="${cls}" src="${esc(c.image)}" alt="${esc(c.name)}" loading="lazy" referrerpolicy="no-referrer">`;}
function badge(c) {return `<span class="tribe ${c.tribe?.toLowerCase() || ''}">${esc(c.tribe || 'Castaway')}</span>`;}
function open() {return isOpen(state.settings);}
function statusPill() {return `<span class="pill ${open()?'green':''}">${icon(open()?'check':'lock')}${open()?'Picking is open':'Teams are locked'}</span>`;}
function heading(eyebrow, title, subtitle='', action='') {return `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1>${subtitle?`<p class="lede">${subtitle}</p>`:''}</div>${action}</div>`;}
function shell(content) {
  const view = route();
  return `<header class="site-header"><a class="brand" href="#/camp"><span class="brand-mark">${torch}</span><span>Survivor <b>draft</b><small>THE PERRY FAMILY</small></span></a>
    <nav aria-label="Main navigation">${[['camp','Camp'],['pick','Pick your team'],['standings','Standings'],['episodes','Episodes'],['rules','Rules']].map(([id,label])=>`<a href="#/${id}" ${view===id?'aria-current="page"':''}>${label}</a>`).join('')}</nav>
    <div class="account">${state.user?button(`<span class="avatar">${esc(state.user.name[0])}</span><span>${esc(state.user.name)}</span>`,'account','account-button'):button('Sign in','signin','button small outline')}</div></header>
    <main id="main" tabindex="-1">${content}</main>
    <footer class="footer"><a class="footer-brand" href="#/camp">${torch} The family has spoken.</a><div>${link('Past seasons','history','text-link')} ${state.member?.role==='admin'?link('Commissioner','admin','text-link'):''}<a href="privacy.html" class="text-link">Privacy</a><a href="https://bensonperry.com" class="text-link">Made by Benson</a></div><small>An unofficial family league. Cast photos © CBS.</small></footer>`;
}
function camp() {
  const signed = state.team.submitted;
  const faces = ['ori-jean-charles','ana-sani','brady-booker','angelica-jelly-loblack','danny-kilby-kilby'].map(id=>state.cast.find(c=>c.id===id)).filter(Boolean);
  return `<section class="hero"><div class="hero-copy"><p class="eyebrow">PERRY FAMILY LEAGUE <span>·</span> SEASON 51</p><h1>Outwit. Outplay.<br><em>Outpick the family.</em></h1><p>Seven castaways. Your best six scores.<br>A whole season of bragging rights.</p><div class="hero-actions">${link(`${signed?'Edit your team':'Pick your team'} ${icon('arrow')}`,'pick','button coral')}${link('How we play','rules','hero-link')}</div><div class="hero-note">${icon(open()?'clock':'lock')} ${open()?'Picks stay open until Benson locks the draft.':'The draft is locked. Let the rivalry begin.'}</div></div>
    <div class="hero-art" aria-hidden="true"><div class="sun"></div><div class="island island-back"></div><div class="island island-front"></div><div class="hero-stamp"><span>FIJI · FALL 2026</span><strong>51</strong><span>THE OPEN ERA</span></div><div class="cast-fan">${faces.map((c,i)=>`<div class="fan-card card-${i}">${image(c)}<span>${esc(c.shortName)}</span></div>`).join('')}</div><div class="art-caption">YOUR TRIBE. YOUR CALL.</div></div></section>
    <div class="season-strip"><div>${statusPill()}<span>Season 51</span></div><div>${icon('people')} <strong>21</strong> castaways</div><div>${icon('star')} <strong>7</strong> picks · best <strong>6</strong> count</div><div>${icon('trophy')} Family bragging rights</div></div>
    <div class="camp-grid"><section class="panel my-team-panel"><div class="section-header"><h2>Your seat at camp</h2>${signed?'<span class="pill green">Team submitted</span>':'<span class="subtle">A new season. A clean slate.</span>'}</div>
    ${signed?`<h3>${esc(signed.name)}</h3><div class="mini-lineup">${signed.picks.map(id=>state.cast.find(c=>c.id===id)).filter(Boolean).map(c=>`<div>${image(c)}<span>${esc(c.shortName)}</span></div>`).join('')}</div><p class="muted">${open()?'Your team is in. You can change it until the draft locks.':'Your seven are set. Follow their scores in the standings.'}</p>${link(`View your team ${icon('arrow')}`,'pick','text-link')}`:`<div class="empty-lineup">${Array.from({length:7},(_,i)=>`<span>${state.draft.picks[i]?image(state.cast.find(c=>c.id===state.draft.picks[i])):i+1}</span>`).join('')}</div><h3>${state.draft.picks.length?`${state.draft.picks.length} picked. Your tribe is taking shape.`:'Who are you taking to the end?'}</h3><p class="muted">Browse the cast, follow your instincts, and build your team.</p>${link(`Build your team ${icon('arrow')}`,'pick','button')}`}</section>
    <aside class="panel field-notes"><span class="eyebrow">THE FIELD GUIDE</span><h2>A little strategy.<br>A lot of family rivalry.</h2><ol><li><span>01</span><div><strong>Choose your seven</strong><p>Everyone can pick any eligible castaway.</p></div></li><li><span>02</span><div><strong>Watch the points add up</strong><p>Placement, idols, and individual immunity.</p></div></li><li><span>03</span><div><strong>Keep your best six</strong><p>Your lowest scorer drops automatically.</p></div></li></ol>${link('Read the full rules '+icon('arrow'),'rules','text-link')}</aside></div>
    <section class="cast-peek"><div class="section-header"><div><p class="eyebrow">A WHOLE NEW CAST</p><h2>Meet your next alliance.</h2></div>${link('Meet the cast '+icon('arrow'),'pick','text-link')}</div><div class="peek-grid">${state.cast.filter(c=>c.placement===null).slice(0,4).map(c=>`<button class="peek-card" data-profile="${c.id}">${image(c)}<div>${badge(c)}<h3>${esc(c.shortName)}</h3><p>${esc(c.occupation)} · ${c.age}</p></div>${icon('arrow')}</button>`).join('')}</div></section>`;
}
function picker() {
  return `${heading('THE DRAFT ROOM', 'Build your tribe.', 'Pick seven castaways. Your best six will count.',statusPill())}
    ${state.online===false?'<div class="notice">You’re working from the latest saved cast. Your picks stay on this device until the league reconnects. <button class="text-link" data-action="refresh">Try again</button></div>':''}
    ${!open()?'<div class="notice">Picking is locked. Your submitted team is final.</div>':''}
    <div class="draft-layout"><section class="cast-browser" aria-label="Choose castaways"><div class="filters"><label class="search">${icon('search')}<input id="cast-search" type="search" placeholder="Search castaways" aria-label="Search castaways" value="${esc(state.search)}"></label><label class="selected-filter"><input id="selected-only" type="checkbox" ${state.selectedOnly?'checked':''}> My picks</label></div><div class="tribe-filters" role="group" aria-label="Filter by tribe">${['All','Toka','Savu','Exile'].map(t=>`<button data-filter="${t}" aria-pressed="${state.filter===t}">${t==='All'?'All tribes':t}</button>`).join('')}<span id="cast-count"></span></div><div id="cast-grid" class="cast-grid">${castCards()}</div><p class="source-note">Cast photos and facts: <a href="${state.season.castSource}" target="_blank" rel="noopener">CBS / Paramount+</a>. Eliminated castaways cannot be picked.</p></section>
    <aside id="team-builder" class="team-builder" aria-label="Your team">${teamBuilder()}</aside></div><div class="mobile-draftbar" id="mobile-draftbar">${mobileDraftbar()}</div>`;
}
function mobileDraftbar() { return `<span><strong>${state.draft.picks.length} / 7</strong> picked</span>${button('Review team '+icon('arrow'),'review','button',state.draft.picks.length!==7||!open()||state.syncing?'disabled':'')}`; }
function visibleCast() {
  return state.cast.filter(c=>c.placement==null && (state.filter==='All'||c.tribe===state.filter) && (!state.selectedOnly||state.draft.picks.includes(c.id)) && `${c.name} ${c.occupation} ${c.hometown}`.toLowerCase().includes(state.search.toLowerCase()));
}
function castCards() {
  const cast = visibleCast();
  return cast.length?cast.map(c=>{
    const picked = state.draft.picks.includes(c.id);
    return `<article class="cast-card ${picked?'picked':''}"><button class="portrait-button" data-profile="${c.id}" aria-label="About ${esc(c.name)}">${image(c)}${badge(c)}</button><div class="cast-card-body"><button class="name-button" data-profile="${c.id}"><h3>${esc(c.shortName)}</h3><span>${esc(c.name)}</span></button><p>${esc(c.occupation)} · ${c.age}</p><button class="pick-button" data-pick="${c.id}" aria-pressed="${picked}" aria-label="${picked?'Remove':'Pick'} ${esc(c.shortName)}" ${!open()||(!picked&&state.draft.picks.length>=7)?'disabled':''}>${icon(picked?'check':'plus')} ${picked?'On your team':'Add to team'}</button></div></article>`;
  }).join(''):`<div class="empty-state"><h3>No castaways here.</h3><p>Try another name or tribe.</p>${button('Clear filters','clear-filters','button outline')}</div>`;
}
function teamBuilder() {
  const submitted = state.team.submitted;
  const changed = submitted && JSON.stringify(submitted)!==JSON.stringify(state.draft);
  return `<div class="builder-top"><span class="eyebrow">YOUR TEAM</span><span class="pick-count">${state.draft.picks.length}<small> / 7</small></span></div><label class="field">Team name<input id="team-name" maxlength="40" placeholder="Something worth cheering for" value="${esc(state.draft.name)}" ${!open()?'disabled':''}></label>
    <div class="team-slots">${Array.from({length:7},(_,i)=>{const c = state.cast.find(c=>c.id===state.draft.picks[i]);return c?`<div class="team-slot filled"><span class="slot-number">${i+1}</span>${image(c)}<div><strong>${esc(c.shortName)}</strong><span>${esc(c.tribe)}${c.placement!=null?' · Eliminated':''}</span></div>${button(icon('close'),'remove','icon-button',`data-id="${c.id}" aria-label="Remove ${esc(c.shortName)}" ${!open()?'disabled':''}`)}</div>`:`<div class="team-slot"><span class="slot-number">${i+1}</span><span class="empty-avatar">${icon('plus')}</span><span class="empty-label">Your next castaway</span></div>`;}).join('')}</div>
    <div class="builder-note">${icon('star')} <span>All seven are equal picks.<br>Your lowest score drops automatically.</span></div>
    <div class="builder-actions">${button(state.syncing?'Saving…':submitted?'Review & update '+icon('arrow'):'Review team '+icon('arrow'),'review','button wide',`${state.draft.picks.length!==7||!open()||state.syncing?'disabled':''}`)}${open()?button('Save draft','save-draft','button outline wide',state.syncing?'disabled':''):''}</div>
    <p class="save-status">${submitted?(changed?'You have changes to submit.':`${icon('check')} Team submitted`):'Selections saved on this device.'}</p>${!state.user?'<p class="fine-print">Sign in to save and submit your team.</p>':!state.member?button('Join the family league','join','text-link'):''}`;
}
function updatePicker() {
  const grid = document.querySelector('#cast-grid'); if(!grid)return;
  const focusKey = document.activeElement?.dataset.pick;
  grid.innerHTML=castCards(); document.querySelector('#team-builder').innerHTML=teamBuilder();
  document.querySelector('#mobile-draftbar').innerHTML=mobileDraftbar();
  document.querySelector('#cast-count').textContent=`${visibleCast().length} castaways`;
  if(focusKey)document.querySelector(`[data-pick="${focusKey}"]`)?.focus({preventScroll:true});
}
function togglePick(id) {
  if(!open() || state.syncing)return;
  if(state.draft.picks.includes(id))state.draft.picks=state.draft.picks.filter(p=>p!==id);
  else if(state.draft.picks.length<7 && state.cast.some(c=>c.id===id&&c.placement==null))state.draft.picks.push(id);
  else return toast('Your seven are picked. Remove someone to make a swap.');
  remember(); updatePicker();
}
function leaderboard() {
  const teams = state.league.teams;
  return `${heading('THE FAMILY LEAGUE','Bragging rights, ranked.',open()?'Teams reveal when the draft locks.':'Every point, every pick, all season long.',button(icon('refresh')+' Refresh','refresh','button outline'))}
    ${!state.user||!state.member?`<div class="panel empty-state">${icon('people','large')}<h2>Your family is your competition.</h2><p>Join the league to see everyone’s teams and follow the standings.</p>${button(state.user?'Join the league':'Sign in to the league',state.user?'join':'signin')}</div>`:
    state.league.hidden?`<div class="notice">${icon('lock')} Picks are private until Benson locks the draft.</div><div class="member-grid">${teams.map(t=>`<article class="panel member-card"><span class="avatar">${esc(t.player[0])}</span><h3>${esc(t.player)}${t.mine?' <small>(you)</small>':''}</h3><p>${esc(t.name)}</p><span class="pill ${t.submitted?'green':''}">${icon(t.submitted?'check':'clock')}${t.submitted?'Team submitted':'Still deciding'}</span></article>`).join('')||'<div class="empty-state"><h2>You’re first at camp.</h2><p>Invite the family to get the league started.</p></div>'}</div>`:
    standings(state.cast,teams.filter(t=>t.submitted),state.season).map(t=>`<details class="standing"><summary><span class="rank">${t.rank===1?icon('trophy'):String(t.rank).padStart(2,'0')}</span><span class="standing-name"><strong>${esc(t.name)}</strong><small>${esc(t.player)}${t.mine?' · Your team':''}</small></span><span class="standing-faces">${t.scored.slice(0,4).map(c=>image(c)).join('')}</span><span class="remaining">${t.remaining} still in</span><span class="score">${t.total}<small>points</small></span><span class="expand">+</span></summary>${scoreTable(t)}</details>`).join('')||'<div class="panel empty-state"><h2>No submitted teams yet.</h2><p>The commissioner can reopen picking.</p></div>'}
    ${state.member&&!state.league.hidden?'<p class="source-note">Active castaways receive a provisional placement floor. Scores include the latest commissioner-entered results. Ties share a rank.</p>':''}`;
}
function scoreTable(team) {
  return `<div class="table-scroll"><table><thead><tr><th>Castaway</th><th>Place</th><th>Gameplay</th><th>Finalist</th><th>Total</th></tr></thead><tbody>${team.scored.map(c=>`<tr class="${c.dropped?'dropped':''}"><th>${esc(c.name)} ${c.dropped?'<span class="pill">Dropped</span>':''}</th><td>${c.placementPoints}${c.placement==null?'*':''}</td><td>${c.gameplayPoints}</td><td>${c.finalistPoints}</td><td><strong>${c.total}</strong></td></tr>`).join('')}</tbody></table></div>`;
}
function rules() {
 return `${heading('THE FAMILY RULEBOOK','Good picks. Clear rules.','The same family format, with every point explained.')}
   <div class="rules-intro"><div><strong>7</strong><span>castaways you pick</span></div><span class="math-symbol">−</span><div><strong>1</strong><span>lowest score dropped</span></div><span class="math-symbol">=</span><div><strong>6</strong><span>scores that count</span></div></div>
   <div class="rules-grid"><section class="panel"><h2>Making your picks</h2><ol class="rules-list"><li>Pick seven different castaways who are still in the game. Everyone may pick the same people; there’s no turn order.</li><li>Name your team and submit it. Saving a draft does not enter your team.</li><li>Change and resubmit your team while picking is open. Benson will lock the draft manually.</li><li>All seven picks are equal. Your six highest individual totals count, including bonuses. You never have to choose an alternate.</li><li>Submitted teams stay private until the draft locks. Only submitted teams enter the standings.</li></ol></section>
   <section class="panel"><h2>How points work</h2><div class="score-rule"><div><strong>Final placement</strong><span>21st = 1 point · 1st = 21 points</span></div><b>22 − place</b></div><div class="score-rule"><div><strong>Sole Survivor</strong><span>Added to the winner’s placement points</span></div><b>+5</b></div><div class="score-rule"><div><strong>Runner-up</strong><span>Added to second place</span></div><b>+3</b></div><div class="score-rule"><div><strong>Individual immunity win</strong><span>Tribal challenge wins don’t count</span></div><b>+1</b></div><div class="score-rule"><div><strong>Idol found / idol played</strong><span>Each confirmed find or play; not Shot in the Dark</span></div><b>+1 each</b></div></section>
   <section class="panel worked-example"><p class="eyebrow">LET’S DO THE MATH</p><h2>Your seven finish on…</h2><div class="example-scores">${[26,20,15,12,8,5,2].map((n,i)=>`<span class="${i===6?'excluded':''}">${n}${i===6?'<small>dropped</small>':''}</span>`).join('')}</div><p><strong>86 points for your team.</strong> The lowest total (2) drops. The other six add up.</p></section>
   <section class="panel"><h2>The little things</h2><details open><summary>What do live scores mean?</summary><p>Castaways still playing receive the minimum placement score they’re guaranteed: eliminated castaways + 1. These provisional points increase as the season progresses. Gameplay bonuses are added separately.</p></details><details><summary>What about a tie?</summary><p>Teams with the same total share the same rank—and the bragging rights. If two castaways tie for your lowest score, dropping either gives the same total.</p></details><details><summary>What if someone quits or is evacuated?</summary><p>Their official finishing place counts. There are no replacement picks after the draft locks; dropping your lowest scorer provides the cushion.</p></details><details><summary>Who updates the scores?</summary><p>Benson records results in the commissioner panel. Corrections recalculate every team and are included in the league export. Episode 1 is sourced from the official CBS recap.</p></details></section></div>`;
}
function episodes() {
  return `${heading('AROUND THE FIRE','The season, episode by episode.','Results are hidden until you’re ready.')}
    <div class="episode-list">${state.episodes.map(ep=>`<article class="panel episode"><div class="episode-number"><small>EPISODE</small><strong>${String(ep.number).padStart(2,'0')}</strong></div><div class="episode-content"><p class="eyebrow">${new Date(ep.date+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</p><h2>${esc(ep.title)}</h2><details><summary>${icon('eye')} Reveal recap & points</summary><p>${esc(ep.summary)}</p>${ep.events.map(e=>`<div class="episode-event"><span><strong>${esc(e.player)}</strong><span>${esc(e.description)}</span></span><b>+${e.points}</b></div>`).join('')}<a class="text-link" href="${ep.source}" target="_blank" rel="noopener">Read the CBS recap ${icon('arrow')}</a></details></div></article>`).join('')}</div><p class="source-note">Recaps are added after episodes air. Commissioner scoring updates may be newer than the written recaps.</p>`;
}
async function history() {
  const selected = location.hash.split('/')[2];
  if(selected && /^s(49|50)$/.test(selected)) {
    const [season,cast,teams] = await Promise.all(['season','contestants','picks'].map(file=>fetch(`data/${selected}/${file}.json`).then(r=>r.json())));
    return `${heading('THE FAMILY ARCHIVE',`Season ${season.number}`, 'Final results from the original family draft.',link('All seasons','history','button outline'))}${standings(cast,teams,season).map(t=>`<details class="standing"><summary><span class="rank">${t.rank}</span><span class="standing-name"><strong>${esc(t.name.replace(/\b\w/g,c=>c.toUpperCase()))}</strong></span><span class="score">${t.total}<small>points</small></span><span>+</span></summary>${scoreTable(t)}</details>`).join('')}`;
  }
  return `${heading('THE FAMILY ARCHIVE','A little family history.','Past picks. Old rivalries. The occasional victory lap.')}<div class="archive-grid">${[50,49].map(n=>`<a href="#/history/s${n}" class="archive-card"><span class="eyebrow">PERRY FAMILY DRAFT</span><h2>Season ${n}</h2><span>Final standings ${icon('arrow')}</span></a>`).join('')}</div>`;
}
function admin() {
  if(state.member?.role!=='admin')return `${heading('COMMISSIONER','League headquarters.')}<div class="panel empty-state"><p>Sign in with your commissioner account to manage the league.</p>${button(state.user?'Enter commissioner invite':'Sign in',state.user?'join':'signin')}</div>`;
  return `${heading('COMMISSIONER','Keep camp in order.','Manage the draft, invite family, and record results.')}
    <div class="admin-grid"><section class="panel"><h2>The draft</h2>${statusPill()}<p>${open()?'Family members can save and resubmit teams. Locking reveals all submitted picks.':'Teams are locked and visible to the family. Reopening allows everyone to edit again.'}</p>${button(open()?'Lock picking & reveal teams':'Reopen picking','toggle-lock','button')}<hr><h3>Invite the family</h3><p>Create an invite link to share yourself. A new link replaces the previous one; existing members keep access.</p>${button('Create invite link','invite','button outline')}<div id="invite-output"></div></section>
    <section class="panel"><h2>Record a result</h2><p class="muted">Enter cumulative totals. Saving corrects the score for every team.</p><form id="result-form"><label class="field">Castaway<select name="id" id="result-cast">${state.cast.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label><div id="result-fields">${resultFields(state.cast[0])}</div><button class="button" type="submit">Save result</button></form></section>
    <section class="panel"><h2>Your league, backed up.</h2><p>Download teams, results, and the recent commissioner change log.</p>${button(icon('download')+' Export league','export','button outline')}</section></div>`;
}
function resultFields(c) {
  return `<div class="form-grid"><label class="field">Final place <small>Blank = still playing</small><input type="number" min="1" max="21" name="placement" value="${c.placement??''}"></label><label class="field">Episode<input type="number" name="episode" min="1" max="30" value="${state.settings.lastEpisode||1}" required></label>${[['immunityWin','Individual immunity'],['idolFound','Idols found'],['idolPlayed','Idols played']].map(([key,label])=>`<label class="field">${label}<input type="number" min="0" max="30" name="${key}" value="${c.bonuses?.[key]||0}" required></label>`).join('')}</div><input type="hidden" name="revision" value="${c.revision||0}">`;
}
async function render() {
  if(!loaded)return; const generation=++routeGeneration;
  let content;
  try {content = route()==='history'?await history():({camp,pick:picker,standings:leaderboard,episodes,rules,admin,join:()=>heading('PERRY FAMILY LEAGUE','Welcome to camp.','Sign in, then use your family invite to join.')+`<div class="panel empty-state">${button(state.user?'Enter invite code':'Sign in',state.user?'join':'signin')}</div>`}[route()]||camp)();}
  catch {content=heading('SOMETHING WENT WRONG','Camp is a little hard to reach.')+button('Try again','refresh');}
  if(generation!==routeGeneration)return;
  app.innerHTML=shell(content);
  if(route()==='pick')document.querySelector('#cast-count').textContent=`${visibleCast().length} castaways`;
}
function showModal(content) {modal.innerHTML=`<button class="modal-close icon-button" data-action="close" aria-label="Close">${icon('close')}</button>${content}`; if(!modal.open)modal.showModal();}
function profile(id) {
  const c=state.cast.find(c=>c.id===id); if(!c)return;
  showModal(`<div class="profile-photo">${image(c)}${badge(c)}</div><div class="modal-body"><p class="eyebrow">MEET THE CASTAWAY</p><h2 id="modal-title">${esc(c.name)}</h2><p class="profile-job">${esc(c.occupation)} · ${c.age}</p><p class="muted">${esc(c.hometown)}</p>${c.placement==null?button(state.draft.picks.includes(id)?'Remove from team':'Add to my team','profile-pick','button wide',`data-id="${c.id}" ${!open()||(!state.draft.picks.includes(id)&&state.draft.picks.length>=7)?'disabled':''}`):'<p>Eliminated castaways are no longer eligible.</p>'}</div>`);
}
async function signin() {if(state.auth){modal.close();await state.auth.signIn();}else toast(state.authError||'Sign-in is loading. Try again in a moment.');}
function joinDialog() {
  if(!state.user)return signin();
  const invite = new URLSearchParams(location.hash.split('?')[1]||'').get('invite')||'';
  showModal(`<div class="modal-body"><p class="eyebrow">PERRY FAMILY LEAGUE</p><h2 id="modal-title">Welcome to the family rivalry.</h2><form id="join-form"><label class="field">Your name<input name="name" maxlength="40" required value="${esc(state.user.name)}" autocomplete="given-name"></label><label class="field">Invite code<input name="code" required value="${esc(invite)}" autocomplete="off" spellcheck="false"></label><p class="form-error" role="alert"></p><button class="button wide">Join the league ${icon('arrow')}</button></form></div>`);
}
async function save(submit=false) {
  if(!state.user)return signin(); if(!state.member)return joinDialog();
  const error=validateTeam(state.draft,state.cast,{complete:submit});if(error)return toast(error);
  state.syncing=true; const team=structuredClone(state.draft); if(route()==='pick')updatePicker();
  try {
    const data=await api('/team',{method:'PUT',body:JSON.stringify({team,revision:state.team.revision,submit})}); state.team=data.team; remember();
    toast(submit?'Your team is in. Let the games begin.':'Draft saved to your account.');
    if(submit){modal.close();await refresh({renderAfter:false});}
  } catch(error){toast(error.message); const inline=modal.querySelector('.form-error');if(inline)inline.textContent=error.message;}
  finally{state.syncing=false;if(route()==='pick')updatePicker();const confirm=modal.querySelector('[data-action="submit"]');if(confirm){confirm.disabled=false;confirm.textContent='Submit team';}}
}
function review() {
  const error=validateTeam(state.draft,state.cast,{complete:true});if(error){document.querySelector('#team-name')?.focus();return toast(error);}
  showModal(`<div class="modal-body"><p class="eyebrow">THE FINAL LOOK</p><h2 id="modal-title">${esc(state.draft.name)}</h2><p class="muted">Your seven. Your best six scores count.</p><div class="review-list">${state.draft.picks.map(id=>state.cast.find(c=>c.id===id)).map(c=>`<div>${image(c)}<strong>${esc(c.name)}</strong>${badge(c)}</div>`).join('')}</div><p>You can change your team until Benson locks picking.</p><p class="form-error" role="alert"></p>${button(state.user&&state.member?'Submit team':state.user?'Join & submit':'Sign in to submit','submit','button wide')}</div>`);
}
async function action(name, target) {
  if(name==='close')return modal.close();
  if(name==='signin')return signin();
  if(name==='join')return joinDialog();
  if(name==='account')return showModal(`<div class="modal-body"><h2 id="modal-title">${esc(state.user.name)}</h2><p>${state.member?'Perry family league · '+esc(state.member.role):'Join the league to submit your team.'}</p><div class="stack">${button('Account settings','profile-account','button outline')}${!state.member?button('Join the league','join','button outline'):''}${state.member?.role==='admin'?link('Commissioner panel','admin','button outline'):''}${button('Sign out','signout','text-link')}</div></div>`);
  if(name==='profile-account'){modal.close();return state.auth.account();}
  if(name==='signout')return state.auth.signOut();
  if(name==='remove')return togglePick(target.dataset.id);
  if(name==='profile-pick'){togglePick(target.dataset.id);modal.close();if(route()!=='pick')location.hash='/pick';return;}
  if(name==='review')return review();
  if(name==='save-draft')return save();
  if(name==='submit'){target.disabled=true;return save(true);}
  if(name==='refresh'){await refresh();return toast(state.online?'League refreshed.':'Could not reconnect. Your local draft is safe.');}
  if(name==='clear-filters'){state.search='';state.filter='All';state.selectedOnly=false;return render();}
  if(name==='toggle-lock')return showModal(`<div class="modal-body"><h2 id="modal-title">${open()?'Lock the draft?':'Reopen picking?'}</h2><p>${open()?'Submitted teams will be revealed. Unsubmitted drafts will not enter the league.':'Everyone will be able to change their picks again. They may have already seen each other’s teams.'}</p>${button(open()?'Lock & reveal teams':'Reopen picking','confirm-lock','button wide')}</div>`);
  if(name==='confirm-lock'){target.disabled=true;Object.assign(state,await api('/admin/settings',{method:'PUT',body:JSON.stringify({open:!open(),revision:state.settings.revision})}));modal.close();await refresh();return toast(open()?'Picking reopened.':'Teams are locked and revealed.');}
  if(name==='invite'){
    const {code}=await api('/admin/invite',{method:'POST',body:'{}'});const url=`${CONFIG.site}/#/join?invite=${code}`;
    document.querySelector('#invite-output').innerHTML=`<label class="field">Family invite link<input readonly value="${esc(url)}" id="invite-link"></label>${button('Copy link','copy-invite','button outline')}`;return;
  }
  if(name==='copy-invite'){await navigator.clipboard.writeText(document.querySelector('#invite-link').value);return toast('Invite link copied.');}
  if(name==='export'){
    const data=await api('/admin/export'); const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`survivor-51-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
  }
}
document.addEventListener('click',async event=>{
  if(event.target.closest('.skip-link')){event.preventDefault();document.querySelector('#main')?.focus();return;}
  const target=event.target.closest('[data-action],[data-pick],[data-profile],[data-filter]');if(!target)return;
  try{
    if(target.dataset.pick)return togglePick(target.dataset.pick);
    if(target.dataset.profile)return profile(target.dataset.profile);
    if(target.dataset.filter){state.filter=target.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',b===target));return updatePicker();}
    await action(target.dataset.action,target);
  }catch(error){toast(error.message);if(target.isConnected)target.disabled=false;}
});
document.addEventListener('input',event=>{
  if(event.target.id==='cast-search'){state.search=event.target.value;updatePicker();}
  if(event.target.id==='team-name'){state.draft.name=event.target.value;remember();}
});
document.addEventListener('change',event=>{
  if(event.target.id==='selected-only'){state.selectedOnly=event.target.checked;updatePicker();}
  if(event.target.id==='result-cast')document.querySelector('#result-fields').innerHTML=resultFields(state.cast.find(c=>c.id===event.target.value));
});
document.addEventListener('submit',async event=>{
  if(!['join-form','result-form'].includes(event.target.id))return;event.preventDefault();
  const form=event.target;const submit=form.querySelector('button[type="submit"],button:not([type])');submit.disabled=true;
  try{
    const data=Object.fromEntries(new FormData(form));
    if(form.id==='join-form'){
      await api('/join',{method:'POST',body:JSON.stringify(data)});modal.close();location.hash='/pick';await refresh();toast('Welcome to camp. Your draft is ready.');
    }else{
      const input={id:data.id,placement:data.placement?Number(data.placement):null,episode:Number(data.episode),revision:Number(data.revision),bonuses:Object.fromEntries(['immunityWin','idolFound','idolPlayed'].map(key=>[key,Number(data[key])]))};
      Object.assign(state,await api('/admin/result',{method:'PUT',body:JSON.stringify(input)}));render();toast('Result saved. Scores recalculated.');
    }
  }catch(error){const inline=form.querySelector('.form-error');if(inline)inline.textContent=error.message;else toast(error.message);}
  finally{submit.disabled=false;}
});
window.addEventListener('hashchange',()=>{modal.close();state.search='';state.filter='All';state.selectedOnly=false;render();window.scrollTo(0,0);});
window.addEventListener('online',()=>refresh());
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.user)refresh();});
modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close();}});
async function boot(){
  try{
    [state.season,state.cast,state.episodes]=await Promise.all(['season','contestants','episodes'].map(file=>fetch(`data/s51/${file}.json`).then(r=>{if(!r.ok)throw new Error('Data unavailable');return r.json();})));
    loaded=true;loadDraft();render();refresh();
    try{state.auth=await initAuth(user=>authChanged(user));await authChanged(state.auth.user);}catch(error){state.authError=error.message;}
  }catch{app.innerHTML='<main class="loading"><h1>Camp couldn’t load.</h1><p>Check your connection and refresh the page.</p><button onclick="location.reload()">Try again</button></main>';}
}
boot();
