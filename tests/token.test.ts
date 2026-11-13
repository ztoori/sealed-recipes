import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenMatches } from '../core/src/token.js';

test('runner token: constant-time match, any length, never an empty secret', () => {
  assert.equal(tokenMatches('s3cret-token', 's3cret-token'), true);
  assert.equal(tokenMatches('s3cret-tokeN', 's3cret-token'), false);
  assert.equal(tokenMatches('s3cret', 's3cret-token'), false, 'a shorter guess is just wrong, not an exception');
  assert.equal(tokenMatches('s3cret-token-and-more', 's3cret-token'), false);
  assert.equal(tokenMatches(undefined, 's3cret-token'), false);
  assert.equal(tokenMatches('', ''), false, 'an unset token never authenticates');
});
