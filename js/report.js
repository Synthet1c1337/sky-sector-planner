// Plain-text pre-visit report for a saved job (shareable by copy or download).

import { formatBearing, compassPoint } from './geo.js';
import { locationAccuracyLabel } from './direction.js';
import { JOB_STATUSES } from './store.js';

export function buildReport(job, assessment = null) {
  const d = job.direction;
  const lines = [
    'PRE-VISIT PLANNING REPORT (planning estimate, not an installation survey)',
    '',
    `Job reference: ${job.reference || '(none)'}`,
    `Status: ${JOB_STATUSES.find((s) => s.id === job.status)?.label ?? job.status}`,
    `Address: ${job.address || '(not recorded)'}`,
    `Postcode: ${job.postcode || '(not recorded)'}`,
    `Coordinates: ${fmt(job.lat, 6)}, ${fmt(job.lon, 6)} (WGS84)`,
    `Location accuracy: ${locationAccuracyLabel(job.locationAccuracy)}${job.locationSource ? ` · source: ${job.locationSource}` : ''}`,
    `Created: ${job.createdAt}`,
    '',
    'SKY SECTOR ESTIMATE',
  ];
  if (d?.status === 'estimate') {
    lines.push(
      `Centre: ${formatBearing(d.centreAzimuth)} true (${compassPoint(d.centreAzimuth)})`,
      `Alignment band: ${formatBearing(d.alignment.from)} to ${formatBearing(d.alignment.to)} (±${d.alignment.halfWidth}°)`,
      `Clearance band: ${formatBearing(d.clearance.from)} to ${formatBearing(d.clearance.to)} (±${d.clearance.halfWidth}°)`,
      ...(d.geoArc ? [`Geostationary arc: peaks ${d.geoArc.peakElevation.toFixed(1)}° above the southern horizon`] : []),
      `Confidence: ${d.confidence.label}`,
      `Method: ${d.method}`,
    );
  } else {
    lines.push('No estimate (insufficient data).', ...(d?.reasons ?? []));
  }
  if (assessment) {
    lines.push('', `ASSESSMENT: ${assessment.status.label}`, ...assessment.concerns.map((c) => `! ${c}`), ...assessment.observations.map((o) => `- ${o}`));
  }
  lines.push('', 'CANDIDATE MOUNTING POSITIONS');
  if (job.mountingPositions.length) {
    job.mountingPositions.forEach((m, i) => lines.push(`M${i + 1}: ${m.label || 'unnamed'} · ${fmt(m.lat, 6)}, ${fmt(m.lon, 6)}`));
  } else lines.push('(none added)');
  lines.push('', 'NOTES', job.notes || '(none)', '', 'ON-SITE FINDINGS');
  const o = job.onSite ?? {};
  lines.push(
    `Bearing shown by Starlink app: ${Number.isFinite(o.observedBearing) ? formatBearing(o.observedBearing) : '(not recorded)'}`,
    `Tilt shown by Starlink app: ${Number.isFinite(o.observedTilt) ? `${o.observedTilt}°` : '(not recorded)'}`,
    `Obstructions: ${o.obstructionNotes || '(not recorded)'}`,
    `Findings: ${o.findings || '(not recorded)'}`,
    `Photos: ${job.photos.length}`,
    '',
    'The official Starlink app must confirm installation suitability, obstructions and alignment.',
  );
  return lines.join('\n');
}

const fmt = (v, dp) => (Number.isFinite(v) ? v.toFixed(dp) : '?');
