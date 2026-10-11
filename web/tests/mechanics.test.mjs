import test from 'node:test';
import assert from 'node:assert/strict';
import { RANKS, lotLevel, rankName, rewardWeight } from '../mechanics.js';

test('acquisition day has no reward weight; only full days count', () => {
  assert.equal(lotLevel(0), 0);
  assert.equal(lotLevel(0.99), 0);
  assert.equal(lotLevel(1.99), 1);
  assert.equal(rewardWeight(1000n, 0), 0n);
});

test('rank is bounded between 0 and 10', () => {
  assert.equal(lotLevel(-4), 0);
  assert.equal(lotLevel(10), 10);
  assert.equal(lotLevel(300), 10);
  assert.equal(rewardWeight(1000n, 7), 7000n);
});

test('rank names run from Recruit to Warlord', () => {
  assert.equal(RANKS.length, 11);
  assert.equal(rankName(0), 'Recruit');
  assert.equal(rankName(7), 'Colonel');
  assert.equal(rankName(42), 'Warlord');
});

test('rank 10 weighs five times rank 2 for the same bag', () => {
  assert.equal(rewardWeight(1000n, 10), 5n * rewardWeight(1000n, 2));
});

test('token amounts retain precision above the JavaScript safe integer range', () => {
  assert.equal(rewardWeight(123456789012345678901234n, 10), 1234567890123456789012340n);
});

test('invalid inputs fail instead of displaying a misleading weight', () => {
  assert.throws(() => lotLevel(NaN));
  assert.throws(() => lotLevel(Infinity));
  assert.throws(() => rewardWeight(-1n, 2));
});
