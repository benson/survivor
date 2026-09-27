import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { compileEpisodes, syncResults, scheduledHour } from '../worker-v2/automatic-results.js';
import { projectSeason } from '../src/episode-view.js';
import { standings } from '../src/domain.js';
import cast from '../data/s51/contestants.json' with {type:'json'};
import source from './fixtures/s51-source.json' with {type:'json'};

const now = new Date('2026-10-01T12:15:00Z');
const sourceFetch = (input = source) => async url => new Response(JSON.stringify(url.endsWith('/commits/master') ? {sha:'a'.repeat(40)} : input[url.split('/').at(-1).replace('.json','')]),{status:200});
function secondEpisode() {
  const data=structuredClone(source);
  data.episodes.push({...data.episodes[0],episode:2,episode_title:'A title that must stay hidden',episode_date:'2026-09-30'});
  data.challenge_results.push(...source.challenge_results.filter(r=>r.castaway_id!=='US0752').map(r=>({...r,episode:2,challenge_id:2,won_individual_immunity:r.castaway_id==='US0771'?1:0})));
  data.boot_mapping.push(...source.boot_mapping.filter(r=>r.castaway_id!=='US0752').map(r=>({...r,episode:2,tribe:'Surprise merge'})));
  Object.assign(data.castaways.find(r=>r.castaway_id==='US0753'),{episode:2,place:20,result:'2nd voted out'});
  data.advantage_movement.push({...data.advantage_movement[0],episode:2,sequence_id:2,event:'Played'});
  return data;
}

test('real source fixture reproduces the premiere without tribal immunity or failed idol credit',()=>{
  const [ep]=compileEpisodes(source,now);
  assert.equal(ep.cast.find(c=>c.id==='aaliyah-puglia').placement,21);
  assert.equal(ep.cast.find(c=>c.id==='rob-antonson').bonuses.idolFound,1);
  assert.equal(ep.cast.find(c=>c.id==='lewis-kelly').bonuses.idolFound,0);
  assert.equal(ep.cast.reduce((n,c)=>n+c.bonuses.immunityWin,0),0);
});
test('future broadcasts, incomplete datasets and duplicate bonus events are never published',()=>{
  const data=secondEpisode();
  assert.equal(compileEpisodes(data,new Date('2026-09-30T23:59:00Z')).length,1);
  data.challenge_results=data.challenge_results.filter(r=>r.episode!==2);
  assert.throws(()=>compileEpisodes(data,now),/awaiting/);
  const duplicate=structuredClone(source);duplicate.advantage_movement.push(duplicate.advantage_movement[0]);
  assert.throws(()=>compileEpisodes(duplicate,now),/Duplicate idol/);
});
test('episode projection removes unseen titles, eliminations, scores and tribe swaps',()=>{
  const episodes=compileEpisodes(secondEpisode(),now);
  const before=projectSeason(cast,episodes,0), ep1=projectSeason(cast,episodes,1), ep2=projectSeason(cast,episodes,2);
  assert(before.cast.every(c=>c.placement===null&&c.tribe==='Castaway'&&Object.values(c.bonuses).every(v=>v===0)));
  assert.equal(ep1.cast.find(c=>c.id==='alexis-levine').placement,null);
  assert.equal(ep2.cast.find(c=>c.id==='alexis-levine').placement,20);
  assert(!JSON.stringify(ep1).includes('Surprise merge'));
  assert(!JSON.stringify(ep1).includes('A title that must stay hidden'));
  assert.deepEqual(ep1.episodes[1],{number:2,date:'2026-09-30',locked:true});
  const team=[{name:'Test',picks:cast.slice(0,7).map(c=>c.id)}];
  assert.notEqual(standings(ep1.cast,team)[0].total,standings(ep2.cast,team)[0].total);
});
test('preferences belong to the signed-in viewer, persist across requests, and reject stale-device writes',async()=>{
  const {request}=fixture({watchedThrough:null});
  assert.equal((await request('/season')).data.view.watchedThrough,0);
  assert.equal((await request('/preferences',{method:'PUT',body:{watchedThrough:1,revision:0,userId:'bob'}})).status,200);
  assert.equal((await request('/season')).data.view.watchedThrough,1);
  assert.equal((await request('/season',{user:'bob'})).data.view.watchedThrough,0);
  assert.equal((await request('/season',{user:null})).data.view.watchedThrough,0);
  assert.equal((await request('/preferences',{method:'PUT',body:{watchedThrough:0,revision:0}})).status,409);
  assert.equal((await request('/preferences',{method:'PUT',body:{watchedThrough:0,revision:1}})).status,200);
  assert.equal((await request('/season')).data.view.watchedThrough,0);
  assert.equal((await request('/preferences',{user:null,method:'PUT',body:{watchedThrough:1,revision:0}})).status,401);
});
test('automatic refresh is idempotent, retains valid data on source failure, and never advances watched progress',async()=>{
  const {env,request,sql}=fixture();
  const first=await syncResults(env,{now,fetcher:sourceFetch(secondEpisode())});
  assert.equal(first.status,'current');assert.equal(first.through,2);
  assert.equal((await request('/season')).data.view.watchedThrough,1);
  assert.equal((await request('/season')).data.cast.find(c=>c.id==='alexis-levine').placement,null);
  const again=await syncResults(env,{now,fetcher:sourceFetch(secondEpisode())});
  assert.equal(again.changed,false);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='episode-sync'").get().n,1);
  const failed=await syncResults(env,{now,fetcher:async()=>new Response('offline',{status:503})});
  assert.equal(failed.status,'retrying');assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM episode_snapshots').get().n,2);
  assert.equal((await request('/season')).data.view.latestEpisode,2);
});
test('a stale watched view cannot reveal eligibility through a team save',async()=>{
  const {request}=fixture({watchedThrough:null});
  const res=await request('/team',{method:'PUT',body:{revision:0,submit:true,team:{name:'Test',picks:cast.slice(0,7).map(c=>c.id)}}});
  assert.equal(res.status,409);assert.match(res.data.error,/Catch up/);assert(!res.data.error.includes('Aaliyah'));
});
test('episode corrections preserve future bonuses and do not mutate historical snapshots',()=>{
  const episodes=compileEpisodes(secondEpisode(),now), original=JSON.stringify(episodes);
  const corrections=[{episode:1,id:'rob-antonson',placement:null,bonuses:{idolFound:2,idolPlayed:0,immunityWin:0},revision:1}];
  const result=projectSeason(cast,episodes,2,corrections).cast.find(c=>c.id==='rob-antonson');
  assert.deepEqual(result.bonuses,{idolFound:2,idolPlayed:1,immunityWin:1});
  assert.equal(JSON.stringify(episodes),original);
  assert.equal(projectSeason(cast,episodes,0,corrections).cast.find(c=>c.id==='rob-antonson').bonuses.idolFound,0);
});
test('morning and retry windows follow Eastern daylight-saving time',()=>{
  assert(scheduledHour(new Date('2026-10-01T12:15:00Z')));
  assert(scheduledHour(new Date('2026-11-05T13:15:00Z')));
  assert(!scheduledHour(new Date('2026-11-05T12:15:00Z')));
  assert(scheduledHour(new Date('2026-11-05T17:15:00Z')));
  assert(!scheduledHour(new Date('2026-10-01T08:15:00Z')));
});

test('failed publication rolls back all episode writes and keeps watched progress',async()=>{
  const {env,sql,request}=fixture();
  sql.exec("CREATE TRIGGER reject_second_episode BEFORE INSERT ON episode_snapshots WHEN NEW.episode=2 BEGIN SELECT RAISE(ABORT,'Simulated storage failure'); END");
  assert.equal((await syncResults(env,{now,fetcher:sourceFetch(secondEpisode())})).status,'retrying');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM episode_snapshots').get().n,0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM audit').get().n,0);
  assert.equal((await request('/season')).data.view.watchedThrough,1);
});

test('a failed correction cannot leave current results and history inconsistent',async()=>{
  const {sql,request}=fixture();
  sql.exec("CREATE TRIGGER reject_history BEFORE INSERT ON result_history BEGIN SELECT RAISE(ABORT,'Simulated history failure'); END");
  const body={id:'rob-antonson',placement:null,bonuses:{idolFound:2,idolPlayed:0,immunityWin:0},episode:1,revision:0};
  assert.equal((await request('/admin/result',{user:'owner',method:'PUT',body})).status,500);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM results').get().n,0);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM result_history').get().n,0);
  assert.equal((await request('/season')).data.cast.find(c=>c.id==='rob-antonson').bonuses.idolFound,1);
});
