import test from 'node:test';
import assert from 'node:assert/strict';
import {lotLevel,votingWeight} from '../mechanics.js';
test('acquisition day has no voting weight; only full days count',()=>{assert.equal(lotLevel(0),0);assert.equal(lotLevel(.99),0);assert.equal(lotLevel(1.99),1);assert.equal(votingWeight(1000n,0),0n);});
test('seniority is bounded between 0 and 10',()=>{assert.equal(lotLevel(-4),0);assert.equal(lotLevel(10),10);assert.equal(lotLevel(300),10);assert.equal(votingWeight(1000n,7),7000n);});
test('token amounts retain precision above the JavaScript safe integer range',()=>{assert.equal(votingWeight(123456789012345678901234n,10),1234567890123456789012340n);});
test('invalid inputs fail instead of displaying misleading voting weight',()=>{assert.throws(()=>lotLevel(NaN));assert.throws(()=>lotLevel(Infinity));assert.throws(()=>votingWeight(-1n,2));});
