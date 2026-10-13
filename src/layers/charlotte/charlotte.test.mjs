import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCharlotte, cmpdTime } from './model.js';
import {
  createCharlotteCollector,
  charlotteProxy,
} from '../../../server/providers/charlotte.js';
const crash = {
  eventNo: 'A123',
  longitude: -80.84,
  latitude: 35.22,
  eventDateTime: '2026-09-30T10:27:00',
  addedDateTimeString: '20260930102700ED',
  typeDescription: 'CRASH',
};
test('CMPD times carry explicit Eastern offsets and invalid coordinates never become points', () => {
  assert.equal(cmpdTime(crash), '2026-09-30T14:27:00.000Z');
  assert.equal(
    cmpdTime({
      ...crash,
      eventDateTime: '2026-01-30T10:27:00',
      addedDateTimeString: '20260130102700ES',
    }),
    '2026-01-30T15:27:00.000Z',
  );
  assert.equal(cmpdTime({ ...crash, addedDateTimeString: '' }), null);
  assert.equal(
    normalizeCharlotte('cmpd', [
      crash,
      crash,
      { ...crash, eventNo: 'B', latitude: null },
      { ...crash, eventNo: 'C', longitude: 0 },
    ]).length,
    1,
  );
  assert.throws(
    () => normalizeCharlotte('cmpd', { message: 'API moved' }),
    /Malformed/,
  );
});
test('closure flag cannot resurrect expired closures, upcoming dates and geometry survive', () => {
  const now = Date.parse('2026-09-30T14:00:00Z');
  const make = (id, start, end, active = 'Yes') => ({
    attributes: {
      OBJECTID: id,
      ACTIVE: active,
      STARTDATE: start,
      ENDDATE: end,
      BLOCKNM: 'Mint St',
    },
    geometry: {
      paths: [
        [
          [-80.85, 35.22],
          [-80.84, 35.23],
        ],
      ],
    },
  });
  const rows = normalizeCharlotte(
    'closures',
    {
      features: [
        make(1, now - 3000, now - 1000),
        make(2, now + 1000, now + 3000),
        make(3, now - 1000, now + 3000),
        make(4, null, null, 'No'),
      ],
    },
    now,
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ['2', '3'],
  );
  assert.equal(rows[0].state, 'Upcoming closure');
  assert.equal(rows[1].paths[0].length, 2);
  assert.throws(() =>
    normalizeCharlotte('closures', { error: {}, features: [] }),
  );
});
test('NCDOT camera links use official host, not untrusted view URLs', () => {
  const rows = normalizeCharlotte('cameras', [
    {
      Id: 99,
      Longitude: -80.84,
      Latitude: 35.22,
      Views: [{ Id: 100, Status: 'Enabled', Url: 'https://evil.invalid/' }],
    },
  ]);
  assert.equal(rows[0].viewerUrl, 'https://drivenc.gov/map/Cctv/100');
  assert.equal(
    normalizeCharlotte('cameras', [
      {
        Id: 99,
        Longitude: -80.84,
        Latitude: 35.22,
        Views: [{ Status: 'Disabled' }],
      },
    ]).length,
    0,
  );
});
test('collector coalesces requests, expires caches, and retries a failed refresh', async () => {
  let calls = 0,
    clock = 100,
    fail = false,
    release;
  const gate = new Promise((resolve) => (release = resolve));
  const collector = createCharlotteCollector({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) await gate;
      if (fail) return new Response('', { status: 500 });
      return Response.json([crash]);
    },
  });
  const a = collector('cmpd'),
    b = collector('cmpd');
  release();
  assert.deepEqual(await a, await b);
  assert.equal(calls, 1);
  await collector('cmpd');
  assert.equal(calls, 1);
  clock += 60001;
  fail = true;
  await assert.rejects(collector('cmpd'));
  assert.equal(calls, 2);
  fail = false;
  await collector('cmpd');
  assert.equal(calls, 3);
});
test('DriveNC needs a server key, passes it only upstream, and removes it from error responses', async () => {
  let calls = 0;
  const collector = createCharlotteCollector({
    getKey: () => '',
    fetchImpl: () => calls++,
  });
  await assert.rejects(collector('cameras'), /NCDOT_API_KEY/);
  assert.equal(calls, 0);
  const plugin = charlotteProxy({
    getKey: () => 'fake-secret',
    fetchImpl: async (url) => {
      assert.equal(url.searchParams.get('key'), 'fake-secret');
      throw new Error(String(url));
    },
  });
  let middleware;
  plugin.configureServer({ middlewares: { use: (fn) => (middleware = fn) } });
  let output = '';
  const res = {
    setHeader() {},
    end(body) {
      output = body;
    },
    statusCode: 200,
  };
  await middleware(
    { url: '/api/charlotte?source=cameras', method: 'GET' },
    res,
    () => assert.fail(),
  );
  assert.equal(res.statusCode, 502);
  assert.ok(!output.includes('fake-secret'));
  await middleware(
    { url: '/api/charlotte?source=invalid', method: 'GET' },
    res,
    () => assert.fail(),
  );
  assert.equal(res.statusCode, 400);
});

test('DriveNC keys are trimmed of whitespace and wrapping quotes', async () => {
  const { cleanKey } = await import('../../../server/providers/charlotte.js');
  assert.equal(cleanKey(' "abc123"\r\n'), 'abc123');
  assert.equal(cleanKey("'abc123'"), 'abc123');
  assert.equal(cleanKey(undefined), '');
  assert.equal(cleanKey('"mismatched'), '"mismatched');
});
