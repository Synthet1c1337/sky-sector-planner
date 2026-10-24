// Direction-estimation service.
//
// This module estimates the SKY REGION a Starlink terminal at a UK property is likely
// to face. It does not, and cannot, give the bearing a particular terminal will
// request: that is decided by the terminal and the official Starlink app, and depends
// on the hardware generation, firmware, service plan and live constellation.
//
// The model is a configurable "regional profile". Everything a profile asserts is
// listed in `basis` with its source and how strong that evidence is, so the profile
// can be replaced when better data exists (see docs/DIRECTION_MODEL.md).
//
// Three things are kept separate:
//   1. Property location        -> supplied by the caller, with its own accuracy.
//   2. Regional sky region      -> this profile (public, regional, approximate).
//   3. Terminal-specific bearing -> NOT modelled; only the official app knows it.
//      The installer's own recorded on-site bearings can be summarised alongside.

import {
  normaliseBearing, sectorBounds, compassPoint, geoArcPeakElevation, geoArcHorizonAzimuths, isValidLatLon,
  distanceMetres, circularStats,
} from './geo.js';

export const MODEL_VERSION = '1.0.0';

export const UK_NORTHERN_SKY_PROFILE = Object.freeze({
  id: 'uk-northern-sky',
  version: MODEL_VERSION,
  name: 'UK regional pattern (northern sky)',
  // Mainland UK, Northern Ireland, Scilly, Shetland. Outside this box the profile does not apply.
  region: { minLat: 49.8, maxLat: 61.0, minLon: -8.7, maxLon: 2.0 },
  centreAzimuthTrue: 0,
  // Band within which reported UK alignment arrows commonly fall (roughly NNW to NNE).
  alignmentHalfWidth: 25,
  // Wider band where low obstructions are still worth noting, because the terminal's
  // field of view is a wide cone (~100–110°) and satellites cross the whole northern sky.
  clearanceHalfWidth: 60,
  fieldOfViewDeg: { min: 100, max: 110 },
  lastReviewed: '2026-10',
  isDemonstrationData: false,
  basis: [
    {
      claim: 'In the Northern Hemisphere, Starlink terminals generally face the northern sky; the app gives the exact target.',
      evidence: 'Starlink support guidance and setup instructions (app-guided alignment; Standard kit lists "software assisted manual orienting").',
      strength: 'strong (direction of sky), weak (exact bearing)',
    },
    {
      claim: 'Exact bearings differ between sites, commonly between NNW and NNE.',
      evidence: 'Installer and user reports; Starlink states the app calculates the target per location. Not an official dataset.',
      strength: 'weak: used only to set the sector width',
    },
    {
      claim: 'Non-geostationary systems avoid pointing near the geostationary arc, which lies in the southern sky from the UK.',
      evidence: 'ITU Radio Regulations Article 22 EPFD limits protecting GSO networks; arc elevation computed exactly from latitude.',
      strength: 'strong (physics and regulation)',
    },
    {
      claim: 'Satellite density in 53°-inclination shells peaks near 53° latitude, so from UK latitudes many satellites pass overhead and to the north.',
      evidence: 'Published Starlink FCC filings (orbital shells and inclinations); orbital geometry.',
      strength: 'moderate',
    },
    {
      claim: 'Field of view is a wide cone, roughly 100–110° depending on the kit.',
      evidence: 'Starlink product specification sheets (Standard: 100° to 110°; Mini: 110°).',
      strength: 'moderate: varies by hardware generation',
    },
  ],
});

export const ESTIMATE_STATUS = Object.freeze({
  ESTIMATE: 'estimate',
  INSUFFICIENT: 'insufficient-data',
});

export const LOCATION_ACCURACY = Object.freeze({
  INSTALLER: 'installer-placed',
  ADDRESS: 'address-point',
  STREET: 'street',
  POSTCODE: 'postcode-centroid',
  AREA: 'area',
  UNKNOWN: 'unknown',
});

export function locationAccuracyLabel(accuracy) {
  return {
    'installer-placed': 'Placed on the roof by you',
    'address-point': 'Address point from map data',
    street: 'Street-level match only',
    'postcode-centroid': 'Postcode centre (approximate)',
    area: 'Area-level match only',
  }[accuracy] ?? 'Unknown accuracy';
}

export function isPreciseLocation(accuracy) {
  return accuracy === LOCATION_ACCURACY.INSTALLER || accuracy === LOCATION_ACCURACY.ADDRESS;
}

export function profileApplies(profile, lat, lon) {
  const r = profile.region;
  return lat >= r.minLat && lat <= r.maxLat && lon >= r.minLon && lon <= r.maxLon;
}

/**
 * @param {{lat:number, lon:number, accuracy?:string}} location
 * @param {object} [profile]   regional profile (defaults to the UK profile)
 * @param {{alignmentHalfWidth?:number, clearanceHalfWidth?:number}} [overrides]  installer settings
 */
export function estimateDirection(location, profile = UK_NORTHERN_SKY_PROFILE, overrides = {}) {
  const base = {
    modelVersion: MODEL_VERSION,
    profileId: profile?.id ?? null,
    isDemonstrationData: Boolean(profile?.isDemonstrationData),
    officialCheckRequired: true,
  };

  if (!location || !isValidLatLon(location.lat, location.lon)) {
    return {
      ...base,
      status: ESTIMATE_STATUS.INSUFFICIENT,
      reasons: ['No valid property coordinates yet. Search for the property or place it on the map.'],
      confidence: { level: 'none', label: 'No estimate' },
    };
  }
  if (!profile || !profileApplies(profile, location.lat, location.lon)) {
    return {
      ...base,
      status: ESTIMATE_STATUS.INSUFFICIENT,
      reasons: [
        'This location is outside the region the direction model covers (the UK).',
        'No public dataset supports a bearing estimate here, so no sector is shown.',
      ],
      confidence: { level: 'none', label: 'No estimate' },
    };
  }

  const centre = normaliseBearing(profile.centreAzimuthTrue);
  const alignmentHalfWidth = clamp(overrides.alignmentHalfWidth ?? profile.alignmentHalfWidth, 5, 90);
  const clearanceHalfWidth = Math.max(alignmentHalfWidth, clamp(overrides.clearanceHalfWidth ?? profile.clearanceHalfWidth, 5, 120));
  const geoElevation = geoArcPeakElevation(location.lat);

  const confidence = {
    level: 'moderate',
    label: 'Moderate for the sky region · low for an exact bearing',
    basis: [
      'Strong public evidence that UK terminals face the northern sky.',
      'No official per-location bearing data is published, so the exact bearing is not determinable here.',
      `The ±${alignmentHalfWidth}° width reflects reported variation, not a measured error bound.`,
    ],
  };

  const notes = [];
  if (location.accuracy === LOCATION_ACCURACY.POSTCODE || location.accuracy === LOCATION_ACCURACY.AREA) {
    notes.push('The property position is approximate. The sky direction barely changes over a few hundred metres, but obstruction checks need the real roof position.');
  }

  return {
    ...base,
    status: ESTIMATE_STATUS.ESTIMATE,
    centreAzimuth: centre,
    centreCompass: compassPoint(centre),
    northReference: 'true',
    alignment: { halfWidth: alignmentHalfWidth, ...sectorBounds(centre, alignmentHalfWidth) },
    clearance: { halfWidth: clearanceHalfWidth, ...sectorBounds(centre, clearanceHalfWidth) },
    geoArc: geoElevation == null ? null : {
      azimuth: location.lat >= 0 ? 180 : 0,
      peakElevation: geoElevation,
      horizon: geoArcHorizonAzimuths(location.lat),
    },
    fieldOfViewDeg: profile.fieldOfViewDeg,
    confidence,
    method: `${profile.name} v${profile.version}: regional sky-region profile centred on true north with a ±${alignmentHalfWidth}° alignment band and a ±${clearanceHalfWidth}° clearance band. Geostationary-arc elevation computed from latitude.`,
    explanation: [
      'Starlink satellites are low-Earth-orbit. From the UK the terminal looks into the northern part of the sky, away from the geostationary satellite arc to the south.',
      `The shaded fan is the band where UK terminals are commonly asked to point (${pad(sectorBounds(centre, alignmentHalfWidth).from)}–${pad(sectorBounds(centre, alignmentHalfWidth).to)}). The paler band is where tall obstructions are worth checking.`,
      'The terminal and the official Starlink app decide the actual bearing and tilt on site.',
    ],
    notes,
    warning: 'Planning estimate only. Use the official Starlink app to check obstructions and confirm alignment before and during installation.',
  };
}

/**
 * Summarises bearings the installer recorded on site (from the official app) at
 * nearby saved jobs. Real observations, so shown separately from the regional model.
 */
export function summariseNearbyObservedBearings(jobs, lat, lon, radiusKm = 25) {
  const nearby = (jobs ?? []).filter((j) =>
    Number.isFinite(j?.onSite?.observedBearing) && isValidLatLon(j.lat, j.lon) &&
    distanceMetres(lat, lon, j.lat, j.lon) <= radiusKm * 1000);
  const stats = circularStats(nearby.map((j) => j.onSite.observedBearing));
  if (!stats || stats.mean == null) return { count: nearby.length, mean: null, spread: null, radiusKm };
  return { count: stats.n, mean: stats.mean, spread: stats.spread, radiusKm };
}

/** True bearing → magnetic, using a declination the installer supplies (east positive). */
export function trueToMagnetic(trueBearing, declinationEast) {
  return normaliseBearing(trueBearing - (Number(declinationEast) || 0));
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, Number(v))); }
function pad(b) { return `${String(Math.round(b) % 360).padStart(3, '0')}°`; }
