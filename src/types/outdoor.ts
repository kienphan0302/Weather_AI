export type OutdoorActivity = 'Walking' | 'Running' | 'Photography';
export type OutdoorDuration = 1 | 2 | 3;
export type PhotographyPreference = 'Daylight photos' | 'Any time';
export type OutdoorScore = { temperature: number; precipitation: number; wind: number; total: number };
export type OutdoorWindow = {
  start: number;
  end: number;
  score: OutdoorScore;
  temperatureMin: number;
  temperatureMax: number;
  precipitationMax: number;
  windMin: number;
  windMax: number;
  daylight: 'daylight' | 'outside' | 'unverified';
};
