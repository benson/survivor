import { CONFIG } from './config.js';
import { initAuth } from './auth.js';
import { icon, torch } from './icons.js';
import { isOpen, standings, validateTeam } from './domain.js';
import { preseasonCast } from './episode-view.js';

const app = document.querySelector('#app'), modal = document.querySelector('#modal');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = { cast: [], baseCast: [], season: null, episodes: [], view: {watchedThrough:0,latestEpisode:1,caughtUp:false}, preferences:{watchedThrough:0,revision:0}, updates:{}, settings: { open: true, deadline: null }, auth: null, user: null, member: null, team: {revision: 0}, league: {teams:[],hidden:true}, draft: {name:'',picks:[]}, search:'', watching:false, online:null, authError:'', syncing:false };
let toastTimer, authUserId, routeGeneration = 0, refreshGeneration = 0, loaded = false;
const route = () => {const page=location.hash.slice(2).split(/[/?]/)[0];return !page||page==='camp'||page==='join'?'team':page;};
const isPicker = () => isOpen(state.settings)&&(route()==='pick'||(route()==='team'&&!state.team.submitted));
function sessionRead(key){try{return sessionStorage.getItem(key);}catch{return null;}}
function sessionWrite(key,value){try{value===null?sessionStorage.removeItem(key):sessionStorage.setItem(key,value);}catch{}}
const localKey = () => `survivor:s51:${state.user?.id || 'guest'}`;
const watchKey = () => `${localKey()}:watched`;
function localRead(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function remember() {
  try { localStorage.setItem(localKey(), JSON.stringify({...state.draft, savedAt:Date.now(), baseRevision:state.team.revision})); }
  catch { toast('Your browser couldn’t keep these picks. Use Save team when you’ve chosen seven.'); }
}
function toast(message) {
  clearTimeout(toastTimer); const el = document.querySelector('#toast'); el.textContent = message; el.classList.add('visible');
  toastTimer = setTimeout(() => el.classList.remove('visible'), 5000);
}
async function api(path, options = {}, publicRequest = false) {
  const token = publicRequest ? null : await state.auth?.token();
  const response = await fetch(CONFIG.api + path, {...options, signal:AbortSignal.timeout(15000), headers:{'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {}), ...options.headers}}).catch(()=>{throw new Error('Couldn’t connect. Please try again.');});
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Could not connect. Please try again.'),{status:response.status});
  return data;
}
async function refresh({renderAfter = true} = {}) {
  if(state.watching)return;
  const generation = ++refreshGeneration, userId = state.user?.id;
  const current = () => generation === refreshGeneration && userId === state.user?.id;
  try {
    const data = await api(state.user ? '/season' : `/season?through=${Number(localRead(watchKey())) || 0}`, {}, !state.user);
    if (!current()) return;
    if (state.view.watchedThrough !== data.view.watchedThrough) {modal.close();}
    Object.assign(state, data); state.online = true;
  } catch { if (!current()) return; state.online = false; }
  if (state.user) {
    try {
      let me = await api('/me'); if (!current()) return;
      if (!me.member) {
        await api('/join',{method:'POST',body:JSON.stringify({name:(state.user.name||'Castaway').trim().slice(0,40)||'Castaway'})});
        if (!current()) return;
        me = await api('/me'); if (!current()) return;
      }
      state.member = me.member;
      const dirty = JSON.stringify(state.draft) !== JSON.stringify(state.team.draft || {name:'',picks:[]});
      if (state.team.revision && me.team?.revision !== state.team.revision && dirty && open()) {
        toast('Your team changed on another device. Refresh before saving.');
      } else state.team = me.team || {revision:0};
      if (!open() && state.team.submitted) state.draft = structuredClone(state.team.submitted);
      const league = me.member ? await api('/league') : {teams:[],hidden:true};
      if (!current()) return; state.league = league;
    } catch (error) { if (!current()) return; state.online = false; toast(error.message); }
  }
  if (current() && renderAfter) render();
}
function resetView() {
  ++refreshGeneration;
  state.cast = preseasonCast(state.baseCast);
  state.episodes = state.episodes.map(ep => ({number:ep.number,date:ep.date,locked:true}));
  state.view = {...state.view,watchedThrough:0,caughtUp:false};
  modal.close();
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
  state.preferences={watchedThrough:0,revision:0}; state.watching=false; resetView(); state.draft={name:'',picks:[]}; render();
  const expectedUser=state.user?.id;
  await refresh({renderAfter:false}); if(state.user?.id!==expectedUser)return; loadDraft(); render();
  if(state.user&&sessionRead('survivor:save-team')==='yes'){
    let picks;try{picks=JSON.parse(sessionRead('survivor:pending-picks'));}catch{}
    if(Array.isArray(picks)&&picks.length===7&&picks.every(id=>state.baseCast.some(c=>c.id===id))){
      state.draft={name:state.team.submitted?.name||'',picks};remember();await save();
    }
  }
}
function button(text, action, cls='button', extra='') {return `<button class="${cls}" data-action="${action}" ${extra}>${text}</button>`;}
function link(text, view, cls='button') {return `<a class="${cls}" href="#/${view}">${text}</a>`;}
function image(c, cls='') {return `<img class="${cls}" src="${esc(c.image)}" alt="${esc(c.name)}" loading="lazy" referrerpolicy="no-referrer">`;}
function open() {return isOpen(state.settings);}
function canEdit() {return open();}
function watchOptions(selected=state.view.watchedThrough) {
  return `<option value="0" ${selected===0?'selected':''}>Not started</option>${Array.from({length:state.view.latestEpisode},(_,i)=>`<option value="${i+1}" ${selected===i+1?'selected':''}>Episode ${i+1}</option>`).join('')}`;
}
function watchBar() {
  return `<aside class="watch-bar" aria-label="Spoiler settings"><label for="watched-select">I’ve watched</label><select id="watched-select" ${state.watching?'disabled':''}>${watchOptions()}</select></aside>`;
}
function spoilerDialog(selected=state.view.watchedThrough) {
  showModal(`<div class="modal-body"><h2 id="modal-title">Hide spoilers</h2><form id="spoiler-form"><label class="field">I’ve watched through<select name="watchedThrough">${watchOptions(selected)}</select></label><p class="form-error" role="alert"></p><button type="submit" class="button wide">Save</button></form></div>`);
}
async function setWatched(watchedThrough) {
  const revision=state.preferences.revision, userId=state.user?.id;
  state.watching=true; resetView(); render(); const generation=++refreshGeneration;
  try {
    const result=state.user?await api('/preferences',{method:'PUT',body:JSON.stringify({watchedThrough,revision})}):await api(`/season?through=${watchedThrough}`,{},true);
    if(generation!==refreshGeneration||userId!==state.user?.id)return;
    Object.assign(state,result);state.online=true;
    try{localStorage.setItem(watchKey(),JSON.stringify(watchedThrough));}catch{}
  }catch(error){toast(error.message);}
  finally{state.watching=false;render();}
}
function statusPill() {return `<span class="pill ${open()?'green':''}">${icon(open()?'check':'lock')}${open()?'Picking is open':'Teams are locked'}</span>`;}
function heading(_eyebrow, title, subtitle='', action='') {return `<div class="page-heading"><div><h1>${title}</h1>${subtitle?`<p class="lede">${subtitle}</p>`:''}</div>${action}</div>`;}
function shell(content) {
  const view=route(), selected=view==='pick'?'team':view;
  return `<header class="site-header"><a class="brand" href="#/team"><span class="brand-mark">${torch}</span><span>Family Survivor<small>SEASON 51</small></span></a>
    <nav aria-label="Main navigation">${[['team','My team'],['standings','Scores'],['episodes','Episodes']].map(([id,label])=>`<a href="#/${id}" ${selected===id?'aria-current="page"':''}>${label}</a>`).join('')}</nav>
    <div class="account">${state.user?button(`<span class="avatar">${esc(state.user.name[0])}</span><span>${esc(state.user.name)}</span>`,'account','account-button'):button('Sign in','signin','button small outline')}</div></header>
    <main id="main" tabindex="-1">${!isPicker()&&['team','standings','episodes','admin'].includes(view)?watchBar():''}${content}</main>
    <footer class="footer"><div>${link('Rules','rules','text-link')}${link('Past seasons','history','text-link')}${state.member?.role==='admin'?link('Settings','admin','text-link'):''}<a href="privacy.html" class="text-link">Privacy</a></div><small>Cast photos © CBS.</small></footer>`;
}
function picker() {
  return `${heading('', 'Pick 7 people', '',!open()?statusPill():'')}
    ${state.online===false?'<div class="notice">You’re offline. You can keep choosing and save when you reconnect. <button class="text-link" data-action="refresh">Retry</button></div>':''}
    ${!open()?'<div class="notice">Picking has ended.</div>':''}
    <div class="draft-layout"><section class="cast-browser" aria-label="Choose your team"><label class="search">${icon('search')}<input id="cast-search" type="search" placeholder="Find someone" aria-label="Find someone" value="${esc(state.search)}"></label><div id="cast-grid" class="cast-grid">${castCards()}</div></section>
    <aside id="team-builder" class="team-builder" aria-label="Your picks">${teamBuilder()}</aside></div><div class="mobile-draftbar" id="mobile-draftbar">${mobileDraftbar()}</div>`;
}
function saveLabel(){return state.syncing?'Saving…':state.user?'Save team':'Sign in & save';}
function saveDisabled(){return state.draft.picks.length!==7||!canEdit()||state.syncing?'disabled':'';}
function mobileDraftbar(){return `<span><strong>${state.draft.picks.length} / 7</strong> picked</span>${button(saveLabel(),'save-team','button',saveDisabled())}`;}
function visibleCast(){return state.baseCast.filter(c=>`${c.name} ${c.occupation}`.toLowerCase().includes(state.search.toLowerCase()));}
function castCards() {
  const cast=visibleCast();
  return cast.length?cast.map(c=>{
    const picked=state.draft.picks.includes(c.id);
    return `<article class="cast-card ${picked?'picked':''}"><button class="portrait-button" data-profile="${c.id}" aria-label="About ${esc(c.name)}">${image(c)}</button><div class="cast-card-body"><h2>${esc(c.shortName)}</h2><p>${esc(c.occupation)}</p><button class="pick-button" data-pick="${c.id}" aria-pressed="${picked}" aria-label="${picked?'Remove':'Pick'} ${esc(c.shortName)}" ${!canEdit()||state.syncing?'disabled':''}>${icon(picked?'check':'plus')} ${picked?'Picked':'Pick'}</button></div></article>`;
  }).join(''):`<div class="empty-state"><p>No matches.</p>${button('Clear search','clear-search','button outline')}</div>`;
}
function teamBuilder() {
  const saved=state.team.submitted;
  const changed=saved&&JSON.stringify(saved.picks)!==JSON.stringify(state.draft.picks);
  return `<div class="builder-top"><h2>Your picks</h2><span class="pick-count">${state.draft.picks.length}<small> / 7</small></span></div>
    <div class="team-slots">${Array.from({length:7},(_,i)=>{const c=state.baseCast.find(c=>c.id===state.draft.picks[i]);return c?`<div class="team-slot filled">${image(c)}<strong>${esc(c.shortName)}</strong>${button(icon('close'),'remove','icon-button',`data-id="${c.id}" aria-label="Remove ${esc(c.shortName)}" ${!canEdit()||state.syncing?'disabled':''}`)}</div>`:`<div class="team-slot empty" aria-label="Empty pick ${i+1}"><span class="empty-avatar">${i+1}</span></div>`;}).join('')}</div>
    <div class="builder-actions">${button(saveLabel(),'save-team','button wide',saveDisabled())}</div>${changed?'<p class="save-status">Unsaved changes</p>':''}`;
}
function updatePicker() {
  const grid=document.querySelector('#cast-grid');if(!grid)return;
  const focusKey=document.activeElement?.dataset.pick;
  grid.innerHTML=castCards();document.querySelector('#team-builder').innerHTML=teamBuilder();document.querySelector('#mobile-draftbar').innerHTML=mobileDraftbar();
  if(focusKey)document.querySelector(`[data-pick="${focusKey}"]`)?.focus({preventScroll:true});
}
function togglePick(id) {
  if(!canEdit()||state.syncing)return false;
  if(state.draft.picks.includes(id))state.draft.picks=state.draft.picks.filter(p=>p!==id);
  else if(state.draft.picks.length<7&&state.baseCast.some(c=>c.id===id))state.draft.picks.push(id);
  else{toast('Remove someone before adding another person.');return false;}
  remember();updatePicker();return true;
}
function leaderboard() {
  const teams = state.league.teams;
  return `${heading('','Scores','',button(icon('refresh')+' Refresh','refresh','button outline'))}
    ${!state.user||!state.member?`<div class="panel empty-state">${icon('people','large')}<h2>Join the family</h2>${button(state.user?'Join the family':'Sign in',state.user?'join':'signin')}</div>`:
    state.league.hidden?`<div class="notice">${icon('lock')} Scores appear when Benson closes picking.</div><div class="member-grid">${teams.map(t=>`<article class="panel member-card"><span class="avatar">${esc(t.player[0])}</span><h3>${esc(t.player)}${t.mine?' <small>(you)</small>':''}</h3><span class="pill ${t.submitted?'green':''}">${icon(t.submitted?'check':'clock')}${t.submitted?'Team saved':'Choosing'}</span></article>`).join('')||'<div class="empty-state"><h2>No teams yet.</h2></div>'}</div>`:
    standings(state.cast,teams.filter(t=>t.submitted),state.season).map(t=>`<details class="standing"><summary><span class="rank">${t.rank===1?icon('trophy'):String(t.rank).padStart(2,'0')}</span><span class="standing-name"><strong>${esc(t.player||t.name)}</strong>${t.mine?'<small>Your team</small>':''}</span><span class="standing-faces">${t.scored.slice(0,4).map(c=>image(c)).join('')}</span><span class="remaining">${t.remaining} still in</span><span class="score">${t.total}<small>points</small></span><span class="expand">+</span></summary>${scoreTable(t)}</details>`).join('')||'<div class="panel empty-state"><h2>No teams yet.</h2><p>Save your team to get started.</p></div>'}
    ${state.member&&!state.league.hidden?'<p class="source-note">Active castaways have provisional placement points.</p>':''}`;
}
function scoreTable(team) {
  return `<div class="table-scroll"><table><thead><tr><th>Castaway</th><th>Place</th><th>Gameplay</th><th>Finalist</th><th>Total</th></tr></thead><tbody>${team.scored.map(c=>`<tr class="${c.dropped?'dropped':''}"><th>${esc(c.name)} ${c.dropped?'<span class="pill">Dropped</span>':''}</th><td>${c.placementPoints}${c.placement==null?'*':''}</td><td>${c.gameplayPoints}</td><td>${c.finalistPoints}</td><td><strong>${c.total}</strong></td></tr>`).join('')}</tbody></table></div>`;
}
function myTeam() {
  if(!state.team.submitted)return open()?picker():`${heading('','Your team','',statusPill())}<div class="notice">Picking has ended.</div>`;
  const team=state.team.submitted, members=team.picks.map(id=>state.cast.find(c=>c.id===id)).filter(Boolean);
  return `${heading('','Your team','',open()?link('Change picks','pick','button outline'):'')}
    <div class="watch-team">${members.map(c=>`<article class="panel watch-castaway">${image(c)}<div><h2>${esc(c.shortName)}</h2><p>${esc(c.occupation)}</p></div></article>`).join('')}</div>
    ${state.view.watchedThrough?`<details class="panel team-score"><summary>Team score · ${standings(state.cast,[team],state.season)[0].total} points</summary>${scoreTable(standings(state.cast,[team],state.season)[0])}</details>`:''}`;
}
function rules() {
  return `${heading('','How to play')}
    <div class="simple-rules"><section class="panel"><ol class="rules-list"><li>Choose seven people and save your team.</li><li>You can change your picks until Benson closes picking.</li><li>Your six highest scores count. The highest team total wins.</li></ol></section>
    <section class="panel"><h2>Points</h2>${[['Final place','21st = 1 point, 1st = 21 points'],['Winner bonus','+5'],['Runner-up bonus','+3'],['Individual immunity win','+1'],['Idol found or played','+1 each']].map(([label,value])=>`<div class="score-rule"><strong>${label}</strong><span>${value}</span></div>`).join('')}
    <details><summary>More about scoring</summary><p>People still playing receive a placement point for each person eliminated, plus one. These scores increase as the season continues. Tied teams share a rank. Quits and evacuations use the official finishing place. Tribal immunity and Shot in the Dark do not earn bonuses.</p></details>
    <details><summary>Updates and spoilers</summary><p>Results update automatically the morning after each episode, once the source is ready. “I’ve watched” controls which results you see. It never moves forward on its own.</p></details></section></div>`;
}
function episodes() {
  return `${heading('','Episodes')}
    <div class="episode-list">${state.episodes.map(ep=>`<article class="panel episode"><div class="episode-number"><small>EPISODE</small><strong>${String(ep.number).padStart(2,'0')}</strong></div><div class="episode-content">${ep.date?`<p class="eyebrow">${new Date(ep.date+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</p>`:''}<h2>${ep.locked?'Not watched yet':esc(ep.title)}</h2>${ep.locked?`${button('I’ve watched this','watch-episode','button outline',`data-episode="${ep.number}"`)}`:`<details><summary>${icon('eye')} Episode results</summary>${ep.summary?`<p>${esc(ep.summary)}</p>`:''}${ep.events.map(e=>`<div class="episode-event"><span><strong>${esc(e.player)}</strong><span>${esc(e.description)}</span></span><b>+${e.points}</b></div>`).join('')}${ep.source?`<a class="text-link" href="${esc(ep.source)}" target="_blank" rel="noopener">Results source ${icon('arrow')}</a>`:''}</details>`}</div></article>`).join('')}</div>
    ${state.updates.status==='retrying'?'<p class="source-note">Updates pending. Showing the last confirmed results.</p>':''}`;
}
async function history() {
  const selected = location.hash.split('/')[2];
  if(selected && /^s(49|50)$/.test(selected)) {
    const [season,cast,teams] = await Promise.all(['season','contestants','picks'].map(file=>fetch(`data/${selected}/${file}.json`).then(r=>r.json())));
    return `${heading('THE FAMILY ARCHIVE',`Season ${season.number}`, '',link('All seasons','history','button outline'))}${standings(cast,teams,season).map(t=>`<details class="standing"><summary><span class="rank">${t.rank}</span><span class="standing-name"><strong>${esc(t.name.replace(/\b\w/g,c=>c.toUpperCase()))}</strong></span><span class="score">${t.total}<small>points</small></span><span>+</span></summary>${scoreTable(t)}</details>`).join('')}`;
  }
  return `${heading('THE FAMILY ARCHIVE','Past seasons.','')}<div class="archive-grid">${[50,49].map(n=>`<a href="#/history/s${n}" class="archive-card"><h2>Season ${n}</h2><span>Final standings ${icon('arrow')}</span></a>`).join('')}</div>`;
}
function admin() {
  if(state.member?.role!=='admin')return `${heading('COMMISSIONER','Settings')}<div class="panel empty-state"><p>Sign in with your commissioner account to manage the league.</p>${!state.user?button('Sign in','signin'):''}</div>`;
  return `${heading('','Settings')}
    <div class="admin-grid"><section class="panel"><h2>Picking</h2>${statusPill()}<p>${open()?'Closing picking reveals everyone’s teams.':'Reopening lets everyone change their teams.'}</p>${button(open()?'Close picking':'Reopen picking','toggle-lock','button')}</section>
    <section class="panel"><h2>Automatic results</h2><p>Checks daily at 8:15 a.m., 12:15 p.m., and 4:15 p.m. Eastern.</p><p>${state.updates.status==='retrying'?'Waiting for complete source data. The last confirmed results are kept.':state.updates.checkedAt?`Last checked ${esc(new Date(state.updates.checkedAt).toLocaleString())}.`:'The first automatic check is pending.'}</p>${button('Check for updates','sync-results','button outline')}<details class="result-correction"><summary>Correct a result</summary>${state.view.caughtUp?`<p class="muted">Enter cumulative totals at the selected episode. Corrections are kept when automatic results update.</p><form id="result-form"><label class="field">Castaway<select name="id" id="result-cast">${state.cast.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label><div id="result-fields">${resultFields(state.cast[0])}</div><button class="button" type="submit">Save correction</button></form>`:`<p>Catch up to the latest available episode before reviewing scoring corrections.</p>${button('Hide spoilers','spoilers','button outline')}`}</details></section>
    <section class="panel"><h2>Export league</h2>${button(icon('download')+' Export league','export','button outline')}</section></div>`;
}
function resultFields(c) {
  return `<div class="form-grid"><label class="field">Final place <small>Blank = still playing</small><input type="number" min="1" max="21" name="placement" value="${c.placement??''}"></label><label class="field">Episode<input type="number" name="episode" min="1" max="30" value="${state.settings.lastEpisode||1}" required></label>${[['immunityWin','Individual immunity'],['idolFound','Idols found'],['idolPlayed','Idols played']].map(([key,label])=>`<label class="field">${label}<input type="number" min="0" max="30" name="${key}" value="${c.bonuses?.[key]||0}" required></label>`).join('')}</div><input type="hidden" name="revision" value="${c.revision||0}">`;
}
async function render() {
  if(!loaded)return; const generation=++routeGeneration;
  let content;
  try {content = route()==='history'?await history():({team:myTeam,pick:()=>open()?picker():myTeam(),standings:leaderboard,episodes,rules,admin,join:()=>heading('','Join the family')+`<div class="panel empty-state">${button(state.user?'Join the family':'Sign in',state.user?'join':'signin')}</div>`}[route()]||myTeam)();}
  catch {content=heading('','Something went wrong')+button('Try again','refresh');}
  if(generation!==routeGeneration)return;
  app.innerHTML=shell(content);
}
function showModal(content) {modal.innerHTML=`<button class="modal-close icon-button" data-action="close" aria-label="Close">${icon('close')}</button>${content}`; if(!modal.open)modal.showModal();}
function profile(id) {
  const c=state.baseCast.find(c=>c.id===id);if(!c)return;
  showModal(`<div class="profile-photo">${image(c)}</div><div class="modal-body"><h2 id="modal-title">${esc(c.name)}</h2><p class="profile-job">${esc(c.occupation)} · ${c.age}</p><p class="muted">${esc(c.hometown)}</p>${button(state.draft.picks.includes(id)?'Remove from team':'Add to team','profile-pick','button wide',`data-id="${c.id}" ${!canEdit()||state.syncing?'disabled':''}`)}</div>`);
}
async function signin() {if(state.auth){modal.close();await state.auth.signIn();}else toast(state.authError||'Sign-in is loading. Try again in a moment.');}
function joinDialog() {
  if(!state.user)return signin();
  showModal(`<div class="modal-body"><h2 id="modal-title">Join the family</h2><form id="join-form"><label class="field">Your name<input name="name" maxlength="40" required value="${esc(state.user.name)}" autocomplete="given-name"></label><p class="form-error" role="alert"></p><button class="button wide">Join ${icon('arrow')}</button></form></div>`);
}
async function save() {
  if(state.syncing)return;
  if(!canEdit())return toast('Picking has ended.');
  state.draft.name=state.draft.name||`${state.member?.name||state.user?.name||'My'}’s team`.slice(0,40);
  const error=validateTeam(state.draft,state.baseCast,{complete:true});if(error)return toast(error);
  if(!state.user||!state.member){
    sessionWrite('survivor:save-team','yes');sessionWrite('survivor:pending-picks',JSON.stringify(state.draft.picks));
    return state.user?joinDialog():signin();
  }
  state.syncing=true;const team=structuredClone(state.draft), userId=state.user.id;updatePicker();
  try {
    const data=await api('/team',{method:'PUT',body:JSON.stringify({team,revision:state.team.revision,submit:true})});
    if(state.user?.id!==userId)return;
    state.team=data.team;remember();sessionWrite('survivor:save-team',null);sessionWrite('survivor:pending-picks',null);modal.close();
    location.hash='/team';render();toast('Team saved.');
  }catch(error){toast(error.message);}
  finally{state.syncing=false;updatePicker();}
}
async function action(name, target) {
  if(name==='close')return modal.close();
  if(name==='watch-episode')return setWatched(Number(target.dataset.episode));
  if(name==='spoilers')return spoilerDialog(target.dataset.episode ? Number(target.dataset.episode) : state.view.watchedThrough);
  if(name==='signin')return signin();
  if(name==='join')return joinDialog();
  if(name==='account')return showModal(`<div class="modal-body"><h2 id="modal-title">${esc(state.user.name)}</h2><div class="stack">${button('Hide spoilers','spoilers','button outline')}${button('Account settings','profile-account','button outline')}${!state.member?button('Join the family','join','button outline'):''}${state.member?.role==='admin'?link('Settings','admin','button outline'):''}${button('Sign out','signout','text-link')}</div></div>`);
  if(name==='profile-account'){modal.close();return state.auth.account();}
  if(name==='signout'){sessionWrite('survivor:save-team',null);sessionWrite('survivor:pending-picks',null);return state.auth.signOut();}
  if(name==='remove')return togglePick(target.dataset.id);
  if(name==='profile-pick'){if(togglePick(target.dataset.id))modal.close();return;}
  if(name==='save-team')return save();
  if(name==='refresh'){await refresh();return toast(state.online?'Updated.':'Couldn’t reconnect. Your picks are still on this device.');}
  if(name==='clear-search'){state.search='';return render();}
  if(name==='toggle-lock')return showModal(`<div class="modal-body"><h2 id="modal-title">${open()?'Close picking?':'Reopen picking?'}</h2><p>${open()?'Everyone’s saved teams will be revealed.':'Everyone will be able to change their picks again.'}</p>${button(open()?'Close picking':'Reopen picking','confirm-lock','button wide')}</div>`);
  if(name==='confirm-lock'){target.disabled=true;Object.assign(state,await api('/admin/settings',{method:'PUT',body:JSON.stringify({open:!open(),revision:state.settings.revision})}));modal.close();await refresh();return toast(open()?'Picking reopened.':'Picking closed.');}
  if(name==='export')return showModal(`<div class="modal-body"><h2 id="modal-title">Export all league results?</h2><p>The export includes every published episode, including ones you haven’t watched.</p>${button('Download all results','confirm-export','button wide')}</div>`);
  if(name==='sync-results'){target.disabled=true;const result=await api('/admin/sync',{method:'POST',body:'{}'});await refresh();return toast(result.status==='current'?'Results checked. Your watched setting is unchanged.':'The source is still updating. Another check will run automatically.');}
  if(name==='confirm-export'){
    const data=await api('/admin/export'); const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`survivor-51-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;
  }
}
document.addEventListener('click',async event=>{
  if(event.target.closest('.skip-link')){event.preventDefault();document.querySelector('#main')?.focus();return;}
  const target=event.target.closest('[data-action],[data-pick],[data-profile]');if(!target)return;
  try{
    if(target.dataset.pick)return togglePick(target.dataset.pick);
    if(target.dataset.profile)return profile(target.dataset.profile);
    await action(target.dataset.action,target);
  }catch(error){toast(error.message);if(target.isConnected)target.disabled=false;}
});
document.addEventListener('input',event=>{
  if(event.target.id==='cast-search'){state.search=event.target.value;updatePicker();}
});
document.addEventListener('change',event=>{
  if(event.target.id==='watched-select')setWatched(Number(event.target.value));
  if(event.target.id==='result-cast')document.querySelector('#result-fields').innerHTML=resultFields(state.cast.find(c=>c.id===event.target.value));
});
document.addEventListener('submit',async event=>{
  if(!['join-form','result-form','spoiler-form'].includes(event.target.id))return;event.preventDefault();
  const form=event.target;const submit=form.querySelector('button[type="submit"],button:not([type])');submit.disabled=true;
  try{
    const data=Object.fromEntries(new FormData(form));
    if(form.id==='spoiler-form'){
      await setWatched(Number(data.watchedThrough));
    }else if(form.id==='join-form'){
      await api('/join',{method:'POST',body:JSON.stringify(data)});modal.close();location.hash='/team';await refresh();
      if(sessionRead('survivor:save-team')==='yes')await save();
    }else{
      const input={id:data.id,placement:data.placement?Number(data.placement):null,episode:Number(data.episode),revision:Number(data.revision),bonuses:Object.fromEntries(['immunityWin','idolFound','idolPlayed'].map(key=>[key,Number(data[key])]))};
      await api('/admin/result',{method:'PUT',body:JSON.stringify(input)});await refresh();toast('Result saved. Scores recalculated.');
    }
  }catch(error){const inline=form.querySelector('.form-error');if(inline&&modal.open)inline.textContent=error.message;else toast(error.message);}
  finally{submit.disabled=false;}
});
window.addEventListener('hashchange',()=>{modal.close();state.search='';render();window.scrollTo(0,0);});
window.addEventListener('online',()=>refresh());
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&loaded&&!state.watching){resetView();render();refresh();}});
modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close();}});
async function boot(){
  try{
    [state.season,state.baseCast]=await Promise.all(['season','contestants'].map(file=>fetch(`data/s51/${file}.json`).then(r=>{if(!r.ok)throw new Error('Data unavailable');return r.json();})));
    state.cast=preseasonCast(state.baseCast); state.episodes=[{number:1,date:'2026-09-23',locked:true}]; loaded=true;loadDraft();render();
    // Wait for identity before applying stored guest progress: another person
    // may be signed in on this browser with an earlier watched episode.
    try{state.auth=await initAuth(user=>authChanged(user));await authChanged(state.auth.user);}catch(error){state.authError=error.message;state.online=false;render();}
  }catch{app.innerHTML='<main class="loading"><h1>Couldn’t load the cast.</h1><p>Check your connection and refresh the page.</p><button onclick="location.reload()">Try again</button></main>';}
}
boot();
