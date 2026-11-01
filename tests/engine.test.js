import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, addPlayer, act, tick, viewFor, CONFIG } from '../js/engine.js';

function seeded(seed = 3) {
  let x = seed;
  return () => ((x = (x * 1664525 + 1013904223) % 4294967296), x / 4294967296);
}
function room(n) {
  const s = createGame('ABCD');
  for (let i = 0; i < n; i++) addPlayer(s, { id: 'p' + i, name: 'P' + i });
  return s;
}
const villagers = (s) => s.players.filter((p) => p.id !== s.gossipId);
function whisperAll(s, now = 0) {
  s.players.forEach((p, i) => {
    const to = s.players[(i + 1) % s.players.length].id;
    assert.equal(act(s, p.id, { type: 'whisper', to, text: 'hint from ' + p.name }, now).ok, true);
  });
}
function toVote(s, now) {
  while (s.phase === 'reveal') tick(s, s.phaseEndsAt);
  assert.equal(s.phase, 'debate');
  s.players.forEach((p) => act(s, p.id, { type: 'ready' }, now));
  assert.equal(s.phase, 'vote');
}

test('lobby rules', () => {
  const s = room(2);
  assert.equal(act(s, 'p0', { type: 'start' }, 0).ok, false);
  assert.equal(addPlayer(s, { id: 'x', name: 'p1' }).ok, false);
  addPlayer(s, { id: 'p2', name: 'P2' });
  assert.equal(act(s, 'p1', { type: 'start' }, 0).ok, false);
  assert.equal(act(s, 'p0', { type: 'start' }, 0, seeded()).ok, true);
  assert.equal(s.phase, 'whisper');
  assert.equal(addPlayer(s, { id: 'late', name: 'Late' }).player.spectator, true);
});

test('roles and words stay secret', () => {
  const s = room(4);
  act(s, 'p0', { type: 'start' }, 0, seeded());
  const g = viewFor(s, s.gossipId, 0);
  assert.equal(g.you.role, 'gossip');
  assert.equal(g.you.word, s.rumor);
  villagers(s).forEach((p) => {
    const v = viewFor(s, p.id, 0);
    assert.equal(v.you.role, 'villager');
    assert.equal(v.you.word, s.truth);
    assert.ok(!JSON.stringify(v).includes(s.rumor), 'villagers never see the rumor');
  });
});

test('whispers: private inbox with sender, anonymous reveal, word ban', () => {
  const s = room(3);
  act(s, 'p0', { type: 'start' }, 0, seeded());
  const v = villagers(s)[0];
  assert.equal(act(s, v.id, { type: 'whisper', to: v.id, text: 'x' }, 0).ok, false);
  assert.equal(act(s, v.id, { type: 'whisper', to: s.gossipId, text: 'it is ' + s.truth }, 0).ok, false);
  whisperAll(s);
  assert.equal(s.phase, 'reveal');
  const inbox = viewFor(s, 'p1', 0).you.inbox;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].from, 'p0');
  const pub = viewFor(s, 'p2', 0).revealed;
  assert.equal(pub.length, 1);
  assert.ok(!('from' in pub[0]));
});

test('catching the Gossip scores the accusers; Gossip can steal with the right guess', () => {
  const s = room(4);
  act(s, 'p0', { type: 'start' }, 0, seeded());
  whisperAll(s);
  toVote(s, 0);
  const g = s.gossipId;
  villagers(s).forEach((p) => act(s, p.id, { type: 'vote', target: g }, 0));
  act(s, g, { type: 'vote', target: villagers(s)[0].id }, 0);
  assert.equal(s.phase, 'guess');
  const opts = viewFor(s, g, 0).you.options;
  assert.equal(opts.length, 3);
  assert.ok(!opts.includes(s.rumor));
  act(s, g, { type: 'guess', word: s.truth }, 0);
  assert.equal(s.phase, 'result');
  villagers(s).forEach((p) => assert.equal(p.score, 2));
  assert.equal(s.players.find((p) => p.id === g).score, 3);
});

test('a tie lets the Gossip escape', () => {
  const s = room(4);
  act(s, 'p0', { type: 'start' }, 0, seeded());
  whisperAll(s);
  toVote(s, 0);
  const [a, b, c, d] = s.players.map((p) => p.id);
  act(s, a, { type: 'vote', target: b }, 0);
  act(s, b, { type: 'vote', target: a }, 0);
  act(s, c, { type: 'vote', target: d }, 0);
  act(s, d, { type: 'vote', target: c }, 0);
  assert.equal(s.phase, 'result');
  assert.equal(s.lastResult.caught, false);
  assert.equal(s.players.find((p) => p.id === s.gossipId).score, 4);
});

test('timers carry a silent table through 3 rounds to the end', () => {
  const s = room(3);
  const rng = seeded(8);
  act(s, 'p0', { type: 'start' }, 0, rng);
  const gossips = [];
  let now = 0;
  for (let i = 0; i < 400 && s.phase !== 'final'; i++) {
    if (s.phase === 'whisper' && !gossips.includes(s.round + ':' + s.gossipId)) gossips.push(s.round + ':' + s.gossipId);
    now = Math.max(now, s.phaseEndsAt);
    tick(s, now, rng);
  }
  assert.equal(s.phase, 'final');
  assert.equal(s.round, CONFIG.rounds);
  for (let i = 1; i < gossips.length; i++) assert.notEqual(gossips[i].split(':')[1], gossips[i - 1].split(':')[1]);
  assert.equal(act(s, 'p0', { type: 'playAgain' }, now).ok, true);
});
