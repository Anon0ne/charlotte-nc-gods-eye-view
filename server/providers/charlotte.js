import { readResponseJsonCapped } from './common/http.js';
import { normalizeCharlotte } from '../../src/layers/charlotte/model.js';
const CLOSURES =
  'https://gis.charlottenc.gov/arcgis/rest/services/CDOT/StreetClosuresAndDetours/MapServer/0/query';
const TTL = { cmpd: 60000, closures: 300000, ncdot: 60000, cameras: 3600000 };
/** Trim whitespace and wrapping quotes that Windows shells and editors add. */
export function cleanKey(value) {
  return String(value ?? '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim();
}

export function createCharlotteCollector({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  getKey = () => cleanKey(process.env.NCDOT_API_KEY),
} = {}) {
  const cache = new Map(),
    pending = new Map();
  return async function collect(feed) {
    if (!Object.hasOwn(TTL, feed)) throw new Error('Unknown Charlotte feed');
    const key = feed === 'ncdot' || feed === 'cameras' ? getKey() : null;
    if ((feed === 'ncdot' || feed === 'cameras') && !key)
      throw Object.assign(
        new Error('Set NCDOT_API_KEY on the server to enable DriveNC data'),
        { status: 503 },
      );
    const cached = cache.get(feed);
    if (cached && cached.key === key && now() - cached.time < TTL[feed])
      return cached.payload;
    // A key change must never reuse a previous account's in-flight request.
    if (pending.get(feed)?.key === key) return pending.get(feed).promise;
    const promise = (async () => {
      let url;
      if (feed === 'cmpd')
        url = new URL('https://cmpdinfo.charlottenc.gov/api/v2.1/Traffic');
      else if (feed === 'closures') {
        url = new URL(CLOSURES);
        for (const [k, v] of Object.entries({
          where: "ACTIVE='Yes'",
          outFields:
            'OBJECTID,BLOCKNM,LOCDESC,BLOCKTYPE,COMMENT,FULLCLOSE,ALTROUTE,STARTDATE,ENDDATE,ACTIVE,last_edited_date,EditDate',
          outSR: '4326',
          f: 'json',
          resultRecordCount: '2000',
        }))
          url.searchParams.set(k, v);
      } else {
        url = new URL(
          `https://www.drivenc.gov/api/v2/get/${feed === 'cameras' ? 'cameras' : 'event'}`,
        );
        url.searchParams.set('key', key);
        url.searchParams.set('format', 'json');
      }
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(
          new Error(`Charlotte upstream HTTP ${response.status}`),
          { upstreamStatus: response.status, keyLength: key?.length },
        );
      }
      const input = await readResponseJsonCapped(response, 8 * 1024 * 1024);
      const payload = {
        rows: normalizeCharlotte(feed, input, now()),
        fetchedAt: now(),
        partial: input?.exceededTransferLimit === true,
      };
      cache.set(feed, { key, time: now(), payload });
      return payload;
    })();
    pending.set(feed, { key, promise });
    try {
      return await promise;
    } finally {
      if (pending.get(feed)?.promise === promise) pending.delete(feed);
    }
  };
}
export function charlotteProxy(options) {
  const collect = createCharlotteCollector(options);
  const install = (server) => {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/api/charlotte') return next();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET');
        return res.end(JSON.stringify({ error: 'GET required' }));
      }
      const feed = url.searchParams.get('source');
      if (!Object.hasOwn(TTL, feed)) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'Unknown Charlotte source' }));
      }
      try {
        res.end(JSON.stringify(await collect(feed)));
      } catch (error) {
        res.statusCode = error.status || 502;
        // Never return fetch error text: upstream URLs contain the developer key.
        const upstreamStatus = error.upstreamStatus;
        const networkCode = error.cause?.code;
        const safeNetworkCodes = [
          'ENOTFOUND',
          'EAI_AGAIN',
          'ECONNREFUSED',
          'ECONNRESET',
          'ETIMEDOUT',
          'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
          'SELF_SIGNED_CERT_IN_CHAIN',
          'CERT_HAS_EXPIRED',
        ];
        let message =
          'Charlotte source unavailable; upstream response could not be loaded';
        if (error.status === 503)
          message = 'Set NCDOT_API_KEY in .env.local, then restart the server';
        else if (Number.isInteger(upstreamStatus))
          message = Number.isInteger(error.keyLength)
            ? `Charlotte upstream HTTP ${upstreamStatus}: DriveNC refused the request. The server loaded a ${error.keyLength}-character NCDOT_API_KEY (DriveNC keys are 32 characters). A PowerShell or system NCDOT_API_KEY variable overrides .env.local.`
            : `Charlotte upstream HTTP ${upstreamStatus}`;
        else if (error.name === 'TimeoutError' || error.name === 'AbortError')
          message = 'Charlotte upstream request timed out';
        else if (safeNetworkCodes.includes(networkCode))
          message = `Charlotte upstream connection failed (${networkCode})`;
        res.end(JSON.stringify({ error: message }));
      }
    });
  };
  return {
    name: 'charlotte-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
