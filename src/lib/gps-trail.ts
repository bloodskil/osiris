/**
 * GPS trail math for the MARAUDER live tracker.
 *
 * The WorldRemote GPS MODULE takes a single fix to tag a capture with the
 * place it was taken from. This module is the other half of that module: given
 * the stream of fixes `watchPosition` produces while the operator moves, it
 * answers what the tracker panel shows — how far the trail has run, how fast
 * it moved, how long it recorded — and serialises the trail as GPX so it can
 * be opened in any GIS tool afterwards. `parseGPX` is the other direction: a
 * trail recorded elsewhere, read back in. `sampleTrail` answers where the
 * trail was at a moment — what the replay strip scrubs — and `plotTrail`
 * turns the fixes into a tiny normalised preview of the route.
 *
 * It is pure on purpose: no geolocation, no timers, no DOM. Everything the
 * browser adds (accuracy, timestamp) enters as data, which is what makes the
 * maths testable offline.
 */

import { distanceM } from './navigation';

/** One position sample, as `navigator.geolocation` reports it. */
export interface GpsFix {
  lat: number;
  lng: number;
  /**
   * Horizontal accuracy in metres, when known. A fix read back from a GPX
   * file has none, and neither do some devices.
   */
  acc?: number;
  /** Altitude in metres, when the device reports one. */
  alt?: number;
  /** Ground speed in metres per second, when the device reports one. */
  speed?: number;
  /** Heading in degrees true, when the device reports one. */
  heading?: number;
  /** Epoch milliseconds of the fix. */
  ts: number;
}

export interface TrailStats {
  fixes: number;
  /** Sum of the distances between consecutive fixes, in metres. */
  distanceM: number;
  /** Time from the first fix to the last, in milliseconds. */
  durationMs: number;
  /**
   * Overall pace: distance over duration, in metres per second. A trail of
   * one fix (or none) has no duration, so this is 0 rather than NaN.
   */
  avgSpeedMps: number;
  /**
   * The fastest gap between two consecutive fixes, in metres per second.
   * Segment-based, so it is available whether or not the device reports a
   * hardware speed. Two fixes sharing a timestamp speed nothing.
   */
  maxSpeedMps: number;
}

/** Per-segment speed; segments with no time delta are 0, not Infinity. */
function segmentSpeed(a: GpsFix, b: GpsFix): number {
  const dtMs = b.ts - a.ts;
  if (dtMs <= 0) return 0;
  return distanceM(a.lat, a.lng, b.lat, b.lng) / (dtMs / 1000);
}

export function summarizeTrail(fixes: GpsFix[]): TrailStats {
  if (fixes.length === 0) {
    return { fixes: 0, distanceM: 0, durationMs: 0, avgSpeedMps: 0, maxSpeedMps: 0 };
  }
  let distance = 0;
  let maxSpeed = 0;
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1];
    const b = fixes[i];
    distance += distanceM(a.lat, a.lng, b.lat, b.lng);
    maxSpeed = Math.max(maxSpeed, segmentSpeed(a, b));
  }
  const durationMs = Math.max(0, fixes[fixes.length - 1].ts - fixes[0].ts);
  return {
    fixes: fixes.length,
    distanceM: distance,
    durationMs,
    avgSpeedMps: durationMs > 0 ? distance / (durationMs / 1000) : 0,
    maxSpeedMps: maxSpeed,
  };
}

/**
 * Whether a new fix is worth a packet in the log. The log is for the story of
 * the scan, not a recorder — while standing still, fixes arrive every couple
 * of seconds and each one would drown it. A fix is logged when the operator
 * has moved a meaningful distance since the last logged one, or when enough
 * time has passed that silence itself would be misleading.
 */
export function shouldLogFix(prev: GpsFix | null, fix: GpsFix, minM = 10, minMs = 15000): boolean {
  if (!prev) return true;
  if (distanceM(prev.lat, prev.lng, fix.lat, fix.lng) >= minM) return true;
  return fix.ts - prev.ts >= minMs;
}

/** `412 m`, `3.07 km` — enough precision to see progress, no noise. */
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

/** `m:ss`, or `h:mm:ss` past the hour. Matches the panel's uptime clock. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The trail as GPX 1.1: one track, one segment, one point per fix. Altitude
 * and time are written when known; nothing else is — GPX has no set place for
 * accuracy or speed, and tools that want them want extensions this file does
 * not claim.
 */
export function toGPX(fixes: GpsFix[], name = 'OSIRIS Marauder GPS trail'): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="OSIRIS Marauder" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <trk>',
    `    <name>${escapeXml(name)}</name>`,
    '    <trkseg>',
  ];
  for (const f of fixes) {
    lines.push(`      <trkpt lat="${f.lat.toFixed(6)}" lon="${f.lng.toFixed(6)}">`);
    if (f.alt != null) lines.push(`        <ele>${f.alt.toFixed(1)}</ele>`);
    lines.push(`        <time>${new Date(f.ts).toISOString()}</time>`);
    lines.push('      </trkpt>');
  }
  lines.push('    </trkseg>', '  </trk>', '</gpx>');
  return lines.join('\n') + '\n';
}

/* ── GPX import — a trail recorded elsewhere, read back in ── */

/**
 * Track and route points, with or without an XML namespace prefix. Segments
 * are flattened and names dropped: a trail here is a list of fixes.
 */
const POINT_RE = /<(?:[A-Za-z][\w.-]*:)?(trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?\1\s*>)/g;

/** GPX spells the attribute `lon`; `lng` is accepted because it is common. */
const LAT_RE = /(?:^|\s)lat\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const LON_RE = /(?:^|\s)(?:lon|lng)\s*=\s*(?:"([^"]*)"|'([^']*)')/;

function attr(re: RegExp, attrs: string): string | null {
  const m = re.exec(attrs);
  return m ? m[1] ?? m[2] ?? null : null;
}

/** A child element's text, prefix-tolerant; null when absent or self-closed. */
function tagText(body: string, name: string): string | null {
  const m = new RegExp(`<(?:[A-Za-z][\\w.-]*:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z][\\w.-]*:)?${name}\\s*>`).exec(body);
  return m ? m[1] : null;
}

/** A finite number inside optional bounds — anything else is null. */
function number(raw: string | null, limit: number): number | null {
  if (raw == null) return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < -limit || n > limit) return null;
  return n;
}

export interface GpxImport {
  fixes: GpsFix[];
  /** Points dropped for a missing or malformed coordinate. */
  skipped: number;
}

/**
 * Read a GPX document back into fixes — the other direction of `toGPX`.
 *
 * `<trkpt>` and `<rtept>` are read in document order; waypoints are not
 * track points and are ignored. A point without usable coordinates is
 * dropped and counted in `skipped`; one without a usable `<time>` gets
 * timestamp 0, which the panel honestly reads as "no duration known".
 * Parsing is regex-based on purpose: it works in a DOM-less test and in
 * the browser alike, and it resolves no entities and fetches nothing — a
 * file cannot make the reader reach outside itself.
 */
export function parseGPX(xml: string): GpxImport {
  const fixes: GpsFix[] = [];
  let skipped = 0;
  for (const m of xml.matchAll(POINT_RE)) {
    const attrs = m[2] ?? '';
    const body = m[3] ?? '';
    const lat = number(attr(LAT_RE, attrs), 90);
    const lng = number(attr(LON_RE, attrs), 180);
    if (lat == null || lng == null) { skipped++; continue; }
    const ele = tagText(body, 'ele');
    const time = tagText(body, 'time');
    const ts = time == null ? 0 : Date.parse(time.trim());
    fixes.push({
      lat,
      lng,
      alt: ele == null ? undefined : number(ele, Infinity) ?? undefined,
      ts: Number.isFinite(ts) ? ts : 0,
    });
  }
  return { fixes, skipped };
}

/* ── Replay — where the trail was at a moment ── */

export interface TrailSample {
  lat: number;
  lng: number;
  alt?: number;
  speed?: number;
  /** Elapsed milliseconds from the first fix, clamped to the trail's span. */
  t: number;
  /** 0..1 along the trail's timeline. */
  progress: number;
  /** Index of the segment's opening fix, for "fix i of n" readouts. */
  index: number;
}

/** A bare sample at one known fix, sharing the caller's clock. */
function bareSample(fixes: GpsFix[], i: number, t: number, progress: number): TrailSample {
  const f = fixes[i];
  return { lat: f.lat, lng: f.lng, alt: f.alt, speed: f.speed, t, progress, index: i };
}

/**
 * Where was the operator `elapsedMs` after the first fix? The replay strip
 * scrubs this. Between two fixes the position is interpolated; altitude is
 * interpolated when both ends carry one, a hardware speed is not invented
 * but carried from the later fix when it exists. Out-of-order or repeated
 * timestamps return a real fix from the trail rather than nonsense — the
 * same inputs `summarizeTrail` already tolerates.
 */
export function sampleTrail(fixes: GpsFix[], elapsedMs: number): TrailSample | null {
  if (fixes.length === 0) return null;
  const duration = Math.max(0, fixes[fixes.length - 1].ts - fixes[0].ts);
  const t = Math.max(0, Math.min(Number.isFinite(elapsedMs) ? elapsedMs : 0, duration));
  const progress = duration > 0 ? t / duration : 1;
  if (duration === 0 || fixes.length === 1) return bareSample(fixes, fixes.length - 1, t, progress);
  if (t === 0) return bareSample(fixes, 0, t, progress);
  if (t === duration) return bareSample(fixes, fixes.length - 1, t, progress);
  const tAbs = fixes[0].ts + t;
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1];
    const b = fixes[i];
    const dt = b.ts - a.ts;
    if (dt <= 0 || tAbs < a.ts || tAbs > b.ts) continue;
    const f = (tAbs - a.ts) / dt;
    const bothAlt = a.alt != null && b.alt != null;
    return {
      lat: a.lat + (b.lat - a.lat) * f,
      lng: a.lng + (b.lng - a.lng) * f,
      alt: bothAlt ? a.alt! + (b.alt! - a.alt!) * f : a.alt ?? b.alt,
      speed: b.speed ?? a.speed,
      t,
      progress,
      index: i - 1,
    };
  }
  return bareSample(fixes, fixes.length - 1, t, progress);
}

export interface TrailPlot {
  /** `"x,y x,y …"` for an SVG <polyline> in the width×height space. */
  points: string;
  /** The same projection, for placing a dot on a sample between fixes. */
  project: (lat: number, lng: number) => { x: number; y: number };
  /** True when every fix sits on the same spot — a dot, not a route. */
  degenerate: boolean;
}

/**
 * The trail as a tiny normalised drawing: a north-up box of the given size,
 * the route centred inside it with padding and drawn with the same aspect
 * correction the globe applies (a degree of longitude shrinks with latitude).
 */
export function plotTrail(fixes: GpsFix[], width = 100, height = 40, pad = 4): TrailPlot {
  if (fixes.length === 0) {
    const x = width / 2;
    const y = height / 2;
    return { points: '', project: () => ({ x, y }), degenerate: true };
  }
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const f of fixes) {
    minLat = Math.min(minLat, f.lat);
    maxLat = Math.max(maxLat, f.lat);
    minLng = Math.min(minLng, f.lng);
    maxLng = Math.max(maxLng, f.lng);
  }
  const midLat = (minLat + maxLat) / 2;
  const kx = Math.max(1e-9, Math.cos((midLat * Math.PI) / 180));
  const spanX = (maxLng - minLng) * kx;
  const spanY = maxLat - minLat;
  const availW = Math.max(1, width - pad * 2);
  const availH = Math.max(1, height - pad * 2);
  const scale = Math.min(availW / Math.max(spanX, 1e-12), availH / Math.max(spanY, 1e-12));
  const drawnW = spanX * scale;
  const drawnH = spanY * scale;
  const offX = pad + (availW - drawnW) / 2;
  const offY = pad + (availH - drawnH) / 2;
  const project = (lat: number, lng: number) => ({
    x: offX + (lng - minLng) * kx * scale,
    y: offY + (maxLat - lat) * scale,
  });
  const points = fixes.map(f => {
    const p = project(f.lat, f.lng);
    return `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  }).join(' ');
  return { points, project, degenerate: spanX < 1e-12 && spanY < 1e-12 };
}
