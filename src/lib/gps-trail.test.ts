import { describe, it, expect } from 'vitest';
import {
  summarizeTrail,
  shouldLogFix,
  formatDistance,
  formatDuration,
  toGPX,
  parseGPX,
  sampleTrail,
  plotTrail,
  type GpsFix,
} from './gps-trail';
import { distanceM } from './navigation';

const fix = (lat: number, lng: number, ts: number, extra: Partial<GpsFix> = {}): GpsFix => ({
  lat,
  lng,
  acc: 5,
  ts,
  ...extra,
});

describe('summarizeTrail', () => {
  it('is all zeros for an empty trail', () => {
    expect(summarizeTrail([])).toEqual({
      fixes: 0,
      distanceM: 0,
      durationMs: 0,
      avgSpeedMps: 0,
      maxSpeedMps: 0,
    });
  });

  it('has no distance and no speed for a single fix', () => {
    const one = fix(52.5163, 13.3777, 1_000);
    expect(summarizeTrail([one])).toEqual({
      fixes: 1,
      distanceM: 0,
      durationMs: 0,
      avgSpeedMps: 0,
      maxSpeedMps: 0,
    });
  });

  it('sums segment distances and measures the wall-clock span', () => {
    const a = fix(52.5163, 13.3777, 0);
    const b = fix(52.5163, 13.385, 10_000);
    const stats = summarizeTrail([a, b]);
    expect(stats.fixes).toBe(2);
    expect(stats.distanceM).toBeCloseTo(distanceM(a.lat, a.lng, b.lat, b.lng), 6);
    expect(stats.durationMs).toBe(10_000);
    expect(stats.avgSpeedMps).toBeCloseTo(stats.distanceM / 10, 6);
  });

  it('takes the fastest segment as max speed, not the average', () => {
    const a = fix(52.5163, 13.3777, 0);
    // ~340 m in 10 s, then ~678 m in 10 s — the second half is the fast one.
    const b = fix(52.5163, 13.382, 10_000);
    const c = fix(52.5163, 13.391, 20_000);
    const stats = summarizeTrail([a, b, c]);
    const expectedMax = Math.max(
      distanceM(a.lat, a.lng, b.lat, b.lng) / 10,
      distanceM(b.lat, b.lng, c.lat, c.lng) / 10,
    );
    expect(stats.maxSpeedMps).toBeCloseTo(expectedMax, 6);
    expect(stats.maxSpeedMps).toBeGreaterThan(stats.avgSpeedMps);
  });

  it('does not divide by zero when two fixes share a timestamp', () => {
    const a = fix(52.5163, 13.3777, 5_000);
    const b = fix(52.5163, 13.3777, 5_000);
    const stats = summarizeTrail([a, b]);
    expect(stats.avgSpeedMps).toBe(0);
    expect(stats.maxSpeedMps).toBe(0);
    expect(Number.isFinite(stats.maxSpeedMps)).toBe(true);
  });

  it('ignores an out-of-order timestamp instead of going negative', () => {
    const a = fix(52.5163, 13.3777, 10_000);
    const b = fix(52.5163, 13.3778, 9_000);
    const stats = summarizeTrail([a, b]);
    expect(stats.durationMs).toBe(0);
    expect(stats.avgSpeedMps).toBe(0);
  });
});

describe('shouldLogFix', () => {
  const here = fix(52.5163, 13.3777, 0);

  it('logs the first fix of a track', () => {
    expect(shouldLogFix(null, here)).toBe(true);
  });

  it('stays quiet while standing still', () => {
    const sameSpot = fix(52.5163, 13.37771, 2_000);
    expect(shouldLogFix(here, sameSpot)).toBe(false);
  });

  it('logs once the operator has moved far enough', () => {
    const walked = fix(52.5163, 13.379, 2_000); // ~90 m east
    expect(shouldLogFix(here, walked)).toBe(true);
  });

  it('logs after enough quiet time even without movement', () => {
    const sameSpot = fix(52.5163, 13.37771, 16_000);
    expect(shouldLogFix(here, sameSpot)).toBe(true);
  });

  it('honours custom thresholds', () => {
    const moved = fix(52.5163, 13.3778, 1_000); // ~7 m east
    expect(shouldLogFix(here, moved, 5, 60_000)).toBe(true);
    expect(shouldLogFix(here, moved, 50, 60_000)).toBe(false);
  });
});

describe('formatDistance', () => {
  it('keeps metres under a kilometre', () => {
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(412.4)).toBe('412 m');
    expect(formatDistance(999)).toBe('999 m');
  });

  it('switches to kilometres at a kilometre, two decimals', () => {
    expect(formatDistance(1000)).toBe('1.00 km');
    expect(formatDistance(1500)).toBe('1.50 km');
    expect(formatDistance(42_195)).toBe('42.20 km');
  });
});

describe('formatDuration', () => {
  it('reads m:ss under an hour', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(1000)).toBe('0:01');
    expect(formatDuration(59_000)).toBe('0:59');
    expect(formatDuration(61_000)).toBe('1:01');
    expect(formatDuration(3_599_000)).toBe('59:59');
  });

  it('adds hours past the hour', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_661_000)).toBe('1:01:01');
  });
});

describe('toGPX', () => {
  it('writes a GPX 1.1 skeleton around the points', () => {
    const gpx = toGPX([]);
    expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(gpx).toContain('<gpx version="1.1" creator="OSIRIS Marauder"');
    expect(gpx).toContain('<trkseg>');
    expect(gpx).toContain('</trkseg>');
    expect(gpx.trimEnd().endsWith('</gpx>')).toBe(true);
  });

  it('writes coordinates at six decimals and the time as ISO 8601', () => {
    const gpx = toGPX([fix(52.5163, 13.3777, Date.UTC(2026, 9, 18, 12, 0, 0))]);
    expect(gpx).toContain('<trkpt lat="52.516300" lon="13.377700">');
    expect(gpx).toContain('<time>2026-10-18T12:00:00.000Z</time>');
  });

  it('writes altitude only when the fix has one', () => {
    const withAlt = toGPX([fix(52.5163, 13.3777, 0, { alt: 34.5 })]);
    expect(withAlt).toContain('<ele>34.5</ele>');
    const withoutAlt = toGPX([fix(52.5163, 13.3777, 0)]);
    expect(withoutAlt).not.toContain('<ele>');
  });

  it('escapes the track name and uses the default when none is given', () => {
    expect(toGPX([], 'Dock 5 & <Bridge>')).toContain('<name>Dock 5 &amp; &lt;Bridge&gt;</name>');
    expect(toGPX([])).toContain('<name>OSIRIS Marauder GPS trail</name>');
  });
});

describe('parseGPX', () => {
  it('round-trips the exporter: coordinates, altitude and times come back', () => {
    const src = [
      fix(52.5163, 13.3777, Date.UTC(2026, 9, 18, 12, 0, 0), { alt: 34.5 }),
      fix(52.5168, 13.3798, Date.UTC(2026, 9, 18, 12, 0, 30)),
    ];
    const { fixes, skipped } = parseGPX(toGPX(src));
    expect(skipped).toBe(0);
    expect(fixes).toHaveLength(2);
    expect(fixes[0].lat).toBeCloseTo(52.5163, 6);
    expect(fixes[0].lng).toBeCloseTo(13.3777, 6);
    expect(fixes[0].alt).toBeCloseTo(34.5, 1);
    expect(fixes[0].ts).toBe(Date.UTC(2026, 9, 18, 12, 0, 0));
    expect(fixes[1].alt).toBeUndefined();
  });

  it('reads route points as well as track points, in document order', () => {
    const xml =
      '<gpx><trk><trkseg><trkpt lat="10" lon="20"><time>2026-10-18T12:00:00Z</time></trkpt></trkseg></trk>' +
      '<rte><rtept lat="11" lon="21"/></rte></gpx>';
    const { fixes } = parseGPX(xml);
    expect(fixes.map(f => [f.lat, f.lng])).toEqual([[10, 20], [11, 21]]);
  });

  it('tolerates namespace prefixes on both sides of the tags', () => {
    const xml = '<gpx:trkpt lat="10" lon="20"><gpx:ele>120.5</gpx:ele></gpx:trkpt>';
    const { fixes } = parseGPX(xml);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].alt).toBeCloseTo(120.5, 1);
  });

  it('drops points without usable coordinates and counts them', () => {
    const xml =
      '<gpx><trkpt lat="91.5" lon="0"/><trkpt lon="0"/><trkpt lat="abc" lon="0"/>' +
      '<trkpt lat="10" lon="-190"/><trkpt lat="10" lon="20.5"/></gpx>';
    const { fixes, skipped } = parseGPX(xml);
    expect(skipped).toBe(4);
    expect(fixes.map(f => [f.lat, f.lng])).toEqual([[10, 20.5]]);
  });

  it('reads self-closed points and single-quoted attributes', () => {
    const { fixes } = parseGPX("<gpx><trkpt lat='10.25' lon='20.5'/></gpx>");
    expect(fixes.map(f => [f.lat, f.lng])).toEqual([[10.25, 20.5]]);
  });

  it('accepts lng as an alias of lon', () => {
    const { fixes } = parseGPX('<gpx><trkpt lat="10" lng="20"/></gpx>');
    expect(fixes.map(f => [f.lat, f.lng])).toEqual([[10, 20]]);
  });

  it('leaves the timestamp at 0 when time is absent or unparseable', () => {
    const { fixes } = parseGPX(
      '<gpx><trkpt lat="1" lon="2"/><trkpt lat="3" lon="4"><time>not-a-date</time></trkpt></gpx>',
    );
    expect(fixes.map(f => f.ts)).toEqual([0, 0]);
  });

  it('keeps a point whose ele is unreadable, dropping only the altitude', () => {
    const { fixes } = parseGPX('<gpx><trkpt lat="1" lon="2"><ele>high</ele></trkpt></gpx>');
    expect(fixes).toHaveLength(1);
    expect(fixes[0].alt).toBeUndefined();
  });

  it('finds nothing, and does not throw, in a document without track points', () => {
    expect(parseGPX('<html><body>not a gpx</body></html>')).toEqual({ fixes: [], skipped: 0 });
    expect(parseGPX('')).toEqual({ fixes: [], skipped: 0 });
  });

  it('ignores waypoints — they are not track points', () => {
    const { fixes, skipped } = parseGPX('<gpx><wpt lat="10" lon="20"><name>Dock 5</name></wpt></gpx>');
    expect(fixes).toEqual([]);
    expect(skipped).toBe(0);
  });
});

describe('sampleTrail', () => {
  const a = fix(52.5163, 13.3777, 0);
  const b = fix(52.5168, 13.3798, 10_000);

  it('is null for an empty trail', () => {
    expect(sampleTrail([], 0)).toBeNull();
  });

  it('returns the only fix of a single-fix trail, at the end of its timeline', () => {
    const s = sampleTrail([a], 5_000);
    expect(s).toMatchObject({ lat: a.lat, lng: a.lng, t: 0, progress: 1, index: 0 });
  });

  it('starts on the first fix at t=0', () => {
    const s = sampleTrail([a, b], 0);
    expect(s).toMatchObject({ lat: a.lat, lng: a.lng, t: 0, progress: 0, index: 0 });
  });

  it('clamps past the end onto the last fix', () => {
    const s = sampleTrail([a, b], 99_999);
    expect(s).toMatchObject({ lat: b.lat, lng: b.lng, t: 10_000, progress: 1, index: 1 });
  });

  it('clamps a negative or non-finite clock onto the first fix', () => {
    expect(sampleTrail([a, b], -5_000)).toMatchObject({ lat: a.lat, t: 0, progress: 0 });
    expect(sampleTrail([a, b], NaN)).toMatchObject({ lat: a.lat, t: 0, progress: 0 });
  });

  it('interpolates between two fixes, halfway in space and in time', () => {
    const s = sampleTrail([a, b], 5_000)!;
    expect(s.lat).toBeCloseTo((a.lat + b.lat) / 2, 10);
    expect(s.lng).toBeCloseTo((a.lng + b.lng) / 2, 10);
    expect(s.t).toBe(5_000);
    expect(s.progress).toBeCloseTo(0.5, 10);
    expect(s.index).toBe(0);
  });

  it('interpolates altitude only when both ends carry one', () => {
    const both = sampleTrail([fix(a.lat, a.lng, 0, { alt: 100 }), fix(b.lat, b.lng, 10_000, { alt: 140 })], 5_000)!;
    expect(both.alt).toBeCloseTo(120, 10);
    const firstOnly = sampleTrail([fix(a.lat, a.lng, 0, { alt: 100 }), b], 5_000)!;
    expect(firstOnly.alt).toBeCloseTo(100, 10);
    const secondOnly = sampleTrail([a, fix(b.lat, b.lng, 10_000, { alt: 140 })], 5_000)!;
    expect(secondOnly.alt).toBeCloseTo(140, 10);
  });

  it('carries a hardware speed rather than inventing one', () => {
    const fromLater = sampleTrail([fix(a.lat, a.lng, 0, { speed: 1.5 }), fix(b.lat, b.lng, 10_000, { speed: 2.5 })], 5_000)!;
    expect(fromLater.speed).toBe(2.5);
    const fromEarlier = sampleTrail([fix(a.lat, a.lng, 0, { speed: 1.5 }), b], 5_000)!;
    expect(fromEarlier.speed).toBe(1.5);
    expect(sampleTrail([a, b], 5_000)!.speed).toBeUndefined();
  });

  it('stays finite when two fixes share a timestamp', () => {
    const s = sampleTrail([fix(52.5, 13.3, 1_000), fix(52.6, 13.4, 1_000)], 500)!;
    expect(Number.isFinite(s.lat)).toBe(true);
    expect(Number.isFinite(s.lng)).toBe(true);
    expect(s).toMatchObject({ lat: 52.6, lng: 13.4, t: 0, progress: 1 });
  });

  it('returns a real trail point, with progress inside 0..1, for unordered timestamps', () => {
    const s = sampleTrail([fix(0, 0, 0), fix(1, 1, 20_000), fix(2, 2, 5_000)], 2_500)!;
    expect(Number.isFinite(s.lat)).toBe(true);
    expect(s.progress).toBeGreaterThanOrEqual(0);
    expect(s.progress).toBeLessThanOrEqual(1);
    expect(s.lat).toBeCloseTo(0.125, 10);
    expect(s.index).toBe(0);
  });
});

describe('plotTrail', () => {
  it('is degenerate and empty for no fixes', () => {
    const p = plotTrail([]);
    expect(p.degenerate).toBe(true);
    expect(p.points).toBe('');
    expect(p.project(1, 2)).toEqual({ x: 50, y: 20 });
  });

  it('draws an east-west route left to right at a constant height', () => {
    const p = plotTrail([fix(0, 0, 0), fix(0, 1, 1)]);
    const [x1, y1] = p.points.split(' ')[0].split(',').map(Number);
    const [x2, y2] = p.points.split(' ')[1].split(',').map(Number);
    expect(x2).toBeGreaterThan(x1);
    expect(y2).toBeCloseTo(y1, 10);
    for (const v of [x1, x2]) expect(v).toBeGreaterThanOrEqual(4);
    for (const v of [x1, x2]) expect(v).toBeLessThanOrEqual(96);
    for (const v of [y1, y2]) expect(v).toBeGreaterThanOrEqual(4);
    for (const v of [y1, y2]) expect(v).toBeLessThanOrEqual(36);
  });

  it('puts north up: a north-south route runs bottom to top', () => {
    const p = plotTrail([fix(0, 0, 0), fix(1, 0, 1)]);
    const [x1, y1] = p.points.split(' ')[0].split(',').map(Number);
    const [x2, y2] = p.points.split(' ')[1].split(',').map(Number);
    expect(x2).toBeCloseTo(x1, 10);
    expect(y2).toBeLessThan(y1);
  });

  it('draws one spot as a centred dot', () => {
    const p = plotTrail([fix(52, 13, 0)]);
    expect(p.degenerate).toBe(true);
    expect(p.project(52, 13)).toEqual({ x: 50, y: 20 });
  });

  it('projects a sample onto exactly where the polyline would be', () => {
    const fixes = [fix(52.51, 13.37, 0), fix(52.53, 13.41, 1)];
    const p = plotTrail(fixes);
    const first = p.points.split(' ')[0];
    const q = p.project(fixes[0].lat, fixes[0].lng);
    expect(first).toBe(`${q.x.toFixed(2)},${q.y.toFixed(2)}`);
  });

  it('shrinks longitude with latitude, so equal degree spans draw taller than wide', () => {
    const p = plotTrail([fix(59.5, 0, 0), fix(60.5, 1, 1)]);
    const [x1, y1] = p.points.split(' ')[0].split(',').map(Number);
    const [x2, y2] = p.points.split(' ')[1].split(',').map(Number);
    expect(x2 - x1).toBeLessThan(y1 - y2);
  });
});
