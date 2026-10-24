# Direction model: how the sky sector is estimated

Code: `js/direction.js` (profile `uk-northern-sky`, model version 1.0.0). Tests: `tests/direction.test.mjs`.

## What the app keeps separate

| Layer | What it is | Where it comes from | Precision |
|---|---|---|---|
| 1. Property location | The point on the ground | Postcode centroid, address point or installer's pin | Labelled per result |
| 2. Regional sky region | Where UK terminals commonly look | This profile (public evidence) | A sector, ±25° |
| 3. Terminal-specific bearing | The arrow the Starlink app shows on site | The terminal and the official app only | Not modelled |

The app never presents layer 2 as layer 3.

## Evidence used

| Claim | Evidence | Strength |
|---|---|---|
| Northern Hemisphere terminals face the northern sky; the app gives the exact target | Starlink setup guidance (app-guided alignment; Standard kit spec lists "software assisted manual orienting") | Strong for the sky region, weak for an exact bearing |
| Exact bearings vary, commonly NNW to NNE in the UK | Installer and user reports | Weak; used only for the sector width |
| NGSO systems avoid the geostationary arc (south of the UK) | ITU Radio Regulations Article 22 EPFD limits; arc elevation computed exactly | Strong |
| 53° shells give high satellite density near 53° latitude | Starlink FCC filings, orbital geometry | Moderate |
| Field of view is a wide cone, about 100–110° | Starlink product specification sheets | Moderate; varies by kit |

**No authoritative per-location dataset exists.** Starlink publishes no public API or dataset of terminal bearings. The terminal has a local gRPC interface that third parties have reverse-engineered. It is undocumented, changes with firmware and only works on a connected dish, so this app does not use it.

## Outputs

- **Centre**: 000° true. **Alignment band**: ±25° (335°–025°). **Clearance band**: ±60° (300°–060°), where tall objects are worth checking.
- **Geostationary arc**: peak elevation due south, `atan2(cos φ − k, sin φ)` with `k = 6378.137 / 42164`. For example, 30.1° at 52.4°N and 21.6° at 60.2°N. The horizon crossings are also computed.
- **Confidence**: "moderate" for the sky region and "low" for an exact bearing, with the reasons stated.
- **Insufficient data**: no valid coordinates, or a location outside the UK bounding box (49.8–61.0°N, 8.7°W–2.0°E).

The installer can change both band widths in Settings. Overrides are clamped, and the clearance band is never narrower than the alignment band.

## Improving the model with real observations

Each saved job can record the bearing and tilt the official app showed on site. For a new property, the app shows the circular mean and spread of recorded bearings within 25 km. This uses the installer's own measurements and is kept separate from the regional profile. It is the most reliable way to tighten estimates over time.

## Replacing the profile

A profile is a plain object with `region`, `centreAzimuthTrue`, `alignmentHalfWidth`, `clearanceHalfWidth`, `basis[]` and `isDemonstrationData`. To add or swap one:

1. Add the profile to `direction.js` with its evidence in `basis`.
2. Set `isDemonstrationData: true` for anything not backed by real data. The flag is carried into results and saved jobs.
3. Bump `MODEL_VERSION`. Saved jobs keep the version and method that produced their estimate.
