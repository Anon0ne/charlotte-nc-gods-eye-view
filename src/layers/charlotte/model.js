export const CHARLOTTE_BOUNDS = {
  west: -81.35,
  south: 34.8,
  east: -80.35,
  north: 35.9,
};
export const CHARLOTTE_LAYERS = [
  {
    id: 'charlotte-traffic',
    feed: 'cmpd',
    name: 'CMPD Traffic Events',
    icon: '🚔',
    source: 'CMPD · approximate locations',
    updateInterval: 60000,
    color: '#ff6655',
  },
  {
    id: 'charlotte-closures',
    feed: 'closures',
    name: 'Charlotte Road Closures',
    icon: '🚧',
    source: 'City of Charlotte / CDOT',
    updateInterval: 300000,
    color: '#ffbd44',
  },
  {
    id: 'charlotte-ncdot',
    feed: 'ncdot',
    name: 'NCDOT Charlotte Events',
    icon: '🚦',
    source: 'NCDOT / DriveNC',
    updateInterval: 60000,
    color: '#f69345',
  },
  {
    id: 'charlotte-cameras',
    feed: 'cameras',
    name: 'Charlotte Traffic Cameras',
    icon: '📹',
    source: 'NCDOT / DriveNC · official images',
    updateInterval: 3600000,
    color: '#45d0ee',
  },
];
const text = (v, n = 2000) =>
  String(v ?? '')
    .trim()
    .slice(0, n);
const number = (v) =>
  v === null || v === undefined || v === '' ? NaN : Number(v);
export function localCoordinate(lon, lat) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= CHARLOTTE_BOUNDS.west &&
    lon <= CHARLOTTE_BOUNDS.east &&
    lat >= CHARLOTTE_BOUNDS.south &&
    lat <= CHARLOTTE_BOUNDS.north
  );
}
const date = (value, scale = 1) => {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value * scale : Date.parse(value);
  const parsed = new Date(ms);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};
// CMPD supplies local wall time; its suffix explicitly distinguishes EDT/EST.
export function cmpdTime(row) {
  const raw = text(row.eventDateTime, 40);
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return date(raw);
  const suffix = text(row.addedDateTimeString).slice(-2);
  return suffix === 'ED' || suffix === 'ES'
    ? date(`${raw}${suffix === 'ED' ? '-04:00' : '-05:00'}`)
    : null;
}
export function normalizeCharlotte(feed, payload, now = Date.now()) {
  const input = feed === 'closures' ? payload?.features : payload;
  if (!Array.isArray(input) || payload?.error)
    throw new Error('Malformed Charlotte source response');
  const rows = [],
    seen = new Set();
  for (const raw of input) {
    let row;
    if (feed === 'cmpd') {
      row = {
        id: text(raw.eventNo, 80),
        lon: number(raw.longitude),
        lat: number(raw.latitude),
        title: text(raw.typeDescription, 180),
        description: [raw.address, raw.typeSubDescription, raw.division]
          .filter(Boolean)
          .join(' · '),
        reportedAt: cmpdTime(raw),
        state: 'Open traffic event',
        details:
          'CMPD public traffic feed; approximate location. This is not a general police dispatch feed.',
      };
    } else if (feed === 'closures') {
      const a = raw.attributes || {};
      if (a.ACTIVE !== 'Yes') continue;
      const end = number(a.ENDDATE),
        start = number(a.STARTDATE);
      if (Number.isFinite(end) && end < now) continue;
      const paths = (raw.geometry?.paths || [])
        .filter(
          (path) =>
            Array.isArray(path) &&
            path.length >= 2 &&
            path.every(
              (p) =>
                Array.isArray(p) && localCoordinate(number(p[0]), number(p[1])),
            ),
        )
        .map((path) => path.map((p) => [number(p[0]), number(p[1])]));
      if (!paths.length) continue;
      const p = paths[0][Math.floor(paths[0].length / 2)];
      row = {
        id: text(a.OBJECTID, 80),
        lon: p[0],
        lat: p[1],
        paths,
        title: text(a.BLOCKNM, 180),
        description: text(
          [a.BLOCKTYPE, a.LOCDESC, a.COMMENT].filter(Boolean).join(' · '),
        ),
        detour: text(a.ALTROUTE),
        reportedAt: date(a.last_edited_date || a.EditDate),
        startsAt: date(a.STARTDATE),
        endsAt: date(a.ENDDATE),
        state:
          Number.isFinite(start) && start > now
            ? 'Upcoming closure'
            : 'Within reported closure dates',
        details: `${a.FULLCLOSE === 'Yes' ? 'Full' : 'Partial'} closure. Dates describe the published window; recurring restrictions may apply.`,
      };
    } else if (feed === 'ncdot') {
      row = {
        id: text(raw.ID, 80),
        lon: number(raw.Longitude),
        lat: number(raw.Latitude),
        title: text(
          [raw.RoadwayName, raw.EventSubType].filter(Boolean).join(' · '),
          180,
        ),
        description: text(raw.Description),
        detour: text(
          Array.isArray(raw.DetourInstructions)
            ? raw.DetourInstructions.join(' ')
            : raw.DetourInstructions,
        ),
        reportedAt: date(raw.LastUpdated || raw.Reported, 1000),
        startsAt: date(raw.StartDate, 1000),
        endsAt: date(raw.PlannedEndDate, 1000),
        state:
          number(raw.StartDate) * 1000 > now
            ? 'Upcoming event'
            : 'Source-listed event',
        details: text(
          [raw.Severity, raw.LanesAffected, raw.Recurrence]
            .filter(Boolean)
            .join(' · '),
        ),
      };
    } else if (feed === 'cameras') {
      const views = Array.isArray(raw.Views)
        ? raw.Views.filter((v) => v.Status === 'Enabled')
        : [];
      if (!views.length || !/^\d+$/.test(String(views[0].Id))) continue;
      row = {
        id: text(raw.Id, 80),
        lon: number(raw.Longitude),
        lat: number(raw.Latitude),
        title: text(raw.Location || raw.Roadway, 180),
        description: text(
          [raw.Roadway, raw.Direction, raw.County].filter(Boolean).join(' · '),
        ),
        state: 'Traffic camera',
        viewerUrl: `https://drivenc.gov/map/Cctv/${encodeURIComponent(text(views[0].Id, 80))}`,
        details:
          'Official DriveNC traffic-camera image. Camera availability is controlled by NCDOT; embedded live video is not enabled.',
      };
    } else throw new Error('Unknown Charlotte feed');
    if (!row.id || !localCoordinate(row.lon, row.lat) || seen.has(row.id))
      continue;
    seen.add(row.id);
    rows.push(row);
    if (rows.length >= 2000) break;
  }
  return rows;
}
