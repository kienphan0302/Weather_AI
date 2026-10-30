import type { OutdoorActivity } from '../types/outdoor.ts';

export const outdoorActivities = ['Walking', 'Running', 'Photography'] as const;
export const outdoorDurations = [1, 2, 3] as const;

// Product heuristics, not medical or safety thresholds. Within the comfort band,
// temperature earns all its points; each degree outside loses 10% of that weight.
// Rain earns weight × (1 − probability/100). Wind earns full points up to the
// comfort speed, then loses 5% of its weight per additional km/h. Clamp at zero.
export const outdoorProfiles: Record<OutdoorActivity, {
  min: number; max: number; windComfort: number;
  weights: { temperature: number; precipitation: number; wind: number };
}> = {
  Walking: { min: 15, max: 25, windComfort: 15, weights: { temperature: 40, precipitation: 40, wind: 20 } },
  Running: { min: 8, max: 18, windComfort: 12, weights: { temperature: 50, precipitation: 30, wind: 20 } },
  Photography: { min: 10, max: 24, windComfort: 8, weights: { temperature: 25, precipitation: 40, wind: 35 } },
};

// Exclude freezing precipitation, heavy rain/snow/showers and thunderstorms.
// Unknown WMO codes also fail closed. Other codes are scored on measurements.
export const outdoorAllowedCodes = new Set([0, 1, 2, 3, 45, 48, 51, 53, 55, 61, 63, 71, 73, 77, 80, 81, 85]);
export const outdoorHourSeconds = 3600;
