// Pre-visit assessment. Deliberately never labels a property "suitable" or "unsuitable":
// map data cannot show roof-level obstructions reliably, so the strongest positive
// statement is "planning estimate, nothing specific flagged".

import { isPreciseLocation, locationAccuracyLabel } from './direction.js';
import { formatBearing, compassPoint } from './geo.js';

export const ASSESSMENT_STATUS = Object.freeze({
  PLANNING: { id: 'planning-estimate', label: 'Planning estimate' },
  VERIFY: { id: 'needs-verification', label: 'Needs on-site verification' },
  INSUFFICIENT: { id: 'insufficient-data', label: 'Insufficient data' },
});

export function buildAssessment({ location, direction, analysis }) {
  const concerns = [];
  const observations = [];
  const toVerify = [
    'Run the obstruction check in the official Starlink app where you plan to mount the dish.',
    'Confirm the bearing and tilt the Starlink app asks for.',
    'Look for trees, chimneys, aerials and neighbouring roofs in the northern sky that map data does not show.',
    'Check roof condition, fixing surface and cable route to the router.',
  ];

  if (!location || direction?.status !== 'estimate') {
    return {
      status: ASSESSMENT_STATUS.INSUFFICIENT,
      reasons: direction?.reasons ?? ['No property location yet.'],
      concerns, observations, toVerify,
    };
  }

  if (!isPreciseLocation(location.accuracy)) {
    concerns.push(`Location is "${locationAccuracyLabel(location.accuracy)}". Drag the pin onto the customer's roof so nearby features are measured from the right place.`);
  }

  if (!analysis) {
    concerns.push('Mapped buildings and trees have not been loaded, so no neighbouring features have been reviewed.');
  } else {
    const s = analysis.summary;
    if (analysis.ownBuilding) {
      const h = analysis.ownBuilding.height;
      observations.push(`Pin sits inside a mapped building outline${h ? ` (height ${h.metres.toFixed(1)} m, ${h.source})` : ' with no mapped height'}.`);
    } else if (isPreciseLocation(location.accuracy)) {
      observations.push('Pin is not inside a mapped building outline. Check it is on the roof you mean.');
    }
    for (const f of analysis.features.filter((x) => x.concern === 'high' || x.concern === 'check').slice(0, 6)) {
      const what = f.name ? `${labelKind(f.kind)} "${f.name}"` : labelKind(f.kind);
      const where = `${Math.round(f.distance)} m at ${formatBearing(f.bearing)} (${compassPoint(f.bearing)})`;
      const angle = f.elevation == null ? 'height not mapped' : `top about ${Math.max(0, Math.round(f.elevation))}° above a ${analysis.assumptions.mountHeight} m mount`;
      (f.concern === 'high' ? concerns : observations).push(`${capitalise(what)} ${where}, ${angle}.`);
    }
    if (s.inClearance === 0) observations.push('No mapped buildings or trees in the northern bands within 120 m. Unmapped trees and roof clutter may still be present.');
    if (s.unknownHeightInSector > 0) concerns.push(`${s.unknownHeightInSector} mapped feature(s) in the northern bands have no height data.`);
  }

  const status = concerns.length ? ASSESSMENT_STATUS.VERIFY : ASSESSMENT_STATUS.PLANNING;
  return { status, reasons: [], concerns, observations, toVerify };
}

function labelKind(kind) {
  return { building: 'building', tree: 'tree', 'tree-row': 'tree row', woodland: 'woodland', mast: 'mast', tower: 'tower', chimney: 'chimney' }[kind] ?? kind;
}
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);
