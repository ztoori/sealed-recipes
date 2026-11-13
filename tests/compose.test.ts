import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkCompose, replayRtmr, runtimeEventDigest } from '../web/src/compose.js';

// The browser's image check (web/src/compose.ts): RTMR3 replay from the Intel-signed quote down to the pinned compose.
const pinned = readFileSync(new URL('../runner/docker-compose.yml', import.meta.url), 'utf8');
const RT = 0x08000001;
async function cvm(dockerCompose: string, tamper: (log: any[]) => void = () => {}) {
  const app_compose = JSON.stringify({ manifest_version: 2, name: 'srs-runner', runner: 'docker-compose', docker_compose_file: dockerCompose, kms_enabled: true });
  const composeHash = createHash('sha256').update(app_compose).digest('hex');
  const events = [
    { event: 'system-preparing', event_payload: '' },
    { event: 'app-id', event_payload: 'ab'.repeat(20) },
    { event: 'compose-hash', event_payload: composeHash },
    { event: 'instance-id', event_payload: 'cd'.repeat(20) },
    { event: 'boot-mr-done', event_payload: '' },
  ];
  const log: any[] = [{ imr: 0, event_type: 1, digest: 'ee'.repeat(48), event: '', event_payload: '' }];
  for (const e of events) log.push({ imr: 3, event_type: RT, ...e, digest: await runtimeEventDigest({ event_type: RT, ...e }) });
  const rtmr3 = await replayRtmr(log.filter((e) => e.imr === 3).map((e) => e.digest)); // what the CPU signed into the quote
  tamper(log);
  return { att: { event_log: JSON.stringify(log), app_compose }, rtmr3, composeHash };
}

test('image check: the pinned compose, measured into RTMR3, passes', async () => {
  const { att, rtmr3, composeHash } = await cvm(pinned);
  const r = await checkCompose(att, rtmr3, pinned);
  assert.ok(r.ok, r.error);
  assert.equal(r.composeHash, composeHash);
  assert.match(r.image ?? '', /^ghcr\.io\/.+@sha256:[0-9a-f]{64}$/);
});

test('image check: CRLF and trailing whitespace in the pinned file do not matter', async () => {
  const { att, rtmr3 } = await cvm(pinned);
  assert.ok((await checkCompose(att, rtmr3, pinned.replace(/\n/g, '\r\n') + '\n\n')).ok);
});

test('image check: a different image fails, even when everything else is consistent', async () => {
  const other = pinned.replace(/@sha256:[0-9a-f]{64}/, '@sha256:' + '0'.repeat(64));
  const { att, rtmr3 } = await cvm(other);
  assert.match((await checkCompose(att, rtmr3, pinned)).error ?? '', /differs from the pinned/);
});

test('image check: a runner cannot swap the payload, the app-compose or the RTMR3', async () => {
  const swapped = await cvm(pinned, (log) => { log.find((e) => e.event === 'compose-hash').event_payload = '11'.repeat(32); });
  assert.match((await checkCompose(swapped.att, swapped.rtmr3, pinned)).error ?? '', /does not match its digest/);

  const honest = await cvm(pinned.replace(/@sha256:[0-9a-f]{64}/, '@sha256:' + '0'.repeat(64)));
  const lie = { ...honest.att, app_compose: JSON.stringify({ ...JSON.parse(honest.att.app_compose), docker_compose_file: pinned }) };
  assert.match((await checkCompose(lie, honest.rtmr3, pinned)).error ?? '', /does not hash to the compose hash/);

  const { att } = await cvm(pinned);
  assert.match((await checkCompose(att, 'ff'.repeat(48), pinned)).error ?? '', /does not replay to the RTMR3/);
  assert.match((await checkCompose({ quote: 'x' } as never, 'ff'.repeat(48), pinned)).error ?? '', /older runner build/);
});

test('image check: a real attestation of the live runner (dstack sends runtime events without digests)', async () => {
  const att = JSON.parse(readFileSync(new URL('../fixtures/tdx/dstack_attestation.json', import.meta.url), 'utf8'));
  const rtmr3 = Buffer.from(att.quote.replace(/^0x/, ''), 'hex').subarray(48 + 472, 48 + 520).toString('hex');
  const measured = JSON.parse(att.app_compose).docker_compose_file;
  const r = await checkCompose(att, rtmr3, measured);
  assert.ok(r.ok, r.error);
  assert.equal(r.composeHash, att.compose_hash);
  assert.ok(!(await checkCompose(att, rtmr3, measured.replace(/@sha256:[0-9a-f]{64}/, '@sha256:' + '0'.repeat(64)))).ok, 'another image fails');
});
