import { describe, it, expect } from 'vitest';
import {
  summarizeTrail,
  shouldLogFix,
  formatDistance,
  formatDuration,
  toGPX,
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
