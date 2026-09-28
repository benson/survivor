import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { standings, validateTeam, isOpen } from '../src/domain.js';
import cast from '../data/s51/contestants.json' with { type:'json' };
const selected = cast.filter(c=>c.placement===null).slice(0,7).map(c=>c.id);
const team = {name:'Test tribe',picks:selected};

test('team validation enforces distinct cast members and seven complete picks',()=>{
  assert.equal(validateTeam(team,cast,{complete:true}),null);
  assert.match(validateTeam({...team,picks:[...selected.slice(0,6),selected[0]]},cast),/once/);
  assert.equal(validateTeam({...team,picks:[cast[0].id]},cast),null);
  assert.match(validateTeam({...team,picks:['not-a-cast-member']},cast),/season/);
  assert.match(validateTeam({...team,picks:selected.slice(0,6)},cast,{complete:true}),/seven/);
  assert.match(validateTeam({...team,name:' '},cast,{complete:true}),/name/);
  assert.equal(validateTeam({name:'',picks:[]},cast),null);
});
test('best six include all bonuses before dropping and ranks share ties',()=>{
  const cast=Array.from({length:7},(_,i)=>({id:String(i),name:String(i),placement:i+1,bonuses:{}}));
  const teams=[{name:'A',picks:cast.map(c=>c.id)},{name:'B',picks:cast.map(c=>c.id)}];
  const scores=standings(cast,teams,{contestantCount:7,picksPerPlayer:6,scoring:{winnerBonus:5,runnerUpBonus:3}});
  assert.equal(scores[0].total,35);assert.equal(scores[1].rank,1);assert.equal(scores[0].scored.filter(c=>c.dropped).length,1);
});
test('manual locking and deadline boundary are enforced',()=>{
  assert.equal(isOpen({open:true,deadline:null}),true);
  assert.equal(isOpen({open:false}),false);
  assert.equal(isOpen({open:true,deadline:'2026-09-30T00:00:00Z'},Date.parse('2026-09-30T00:00:00Z')),false);
});
test('anonymous and non-members cannot access private league data',async()=>{
  const {request}=fixture();
  assert.equal((await request('/league',{user:null})).status,401);
  assert.equal((await request('/league',{user:'outsider'})).status,403);
  assert.equal((await request('/admin/export',{user:'alice'})).status,403);
  assert.equal((await request('/season',{origin:'https://evil.example'})).status,403);
});
test('draft is separate from submitted picks, and another member cannot see picks before lock',async()=>{
  const {request}=fixture();
  assert.equal((await request('/team',{method:'PUT',body:{team,revision:0,submit:true}})).status,200);
  const revised={...team,name:'Changed draft'};
  assert.equal((await request('/team',{method:'PUT',body:{team:revised,revision:1,submit:false}})).status,200);
  const me=(await request('/me')).data;
  assert.equal(me.team.draft.name,'Changed draft');assert.equal(me.team.submitted.name,'Test tribe');
  const before=(await request('/league',{user:'bob'})).data;
  assert.equal(before.hidden,true);assert.equal(before.teams.find(t=>t.player==='Alice').picks,undefined);
  assert.equal((await request('/admin/settings',{user:'owner',method:'PUT',body:{open:false,revision:0}})).status,200);
  const after=(await request('/league',{user:'bob'})).data;
  assert.deepEqual(after.teams.find(t=>t.player==='Alice').picks,selected);
  assert.equal((await request('/team',{method:'PUT',body:{team,revision:2,submit:true}})).status,423);
});
test('stale device saves do not overwrite an existing team',async()=>{
  const {request}=fixture();
  await request('/team',{method:'PUT',body:{team,revision:0,submit:true}});
  assert.equal((await request('/team',{method:'PUT',body:{team:{...team,name:'Wrong'},revision:0,submit:true}})).status,409);
  assert.equal((await request('/me')).data.team.submitted.name,'Test tribe');
});
test('client-supplied user id cannot overwrite someone else’s picks',async()=>{
  const {request}=fixture();
  await request('/team',{method:'PUT',body:{team,revision:0,submit:true}});
  await request('/team',{user:'bob',method:'PUT',body:{userId:'alice',team:{...team,name:'Bob'},revision:0,submit:true}});
  assert.equal((await request('/me')).data.team.submitted.name,'Test tribe');
});
test('only commissioner records validated, versioned results',async()=>{
  const {request}=fixture();
  const input={id:selected[0],placement:20,bonuses:{immunityWin:1,idolFound:0,idolPlayed:0},episode:2,revision:0};
  assert.equal((await request('/admin/result',{method:'PUT',body:input})).status,403);
  assert.equal((await request('/admin/result',{user:'owner',method:'PUT',body:input})).status,200);
  assert.equal((await request('/admin/result',{user:'owner',method:'PUT',body:input})).status,409);
  assert.equal((await request('/admin/result',{user:'owner',method:'PUT',body:{...input,id:selected[1]}})).status,400);
  assert.equal((await request('/admin/export',{user:'owner'})).data.audit.length,1);
});
