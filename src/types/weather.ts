export type City = {
  id: string;
  name: string;
  region?: string;
  country?: string;
  latitude: number;
  longitude: number;
};

export type HourForecast = {
  time: number;
  temperature: number | null;
  precipitationProbability: number | null;
  code: number | null;
  isDay: boolean;
};

export type DayForecast = {
  time: number;
  min: number | null;
  max: number | null;
  code: number | null;
  precipitationProbability: number | null;
};

export type Weather = {
  timezone: string;
  utcOffsetSeconds: number;
  observedAt: number;
  fetchedAt: number;
  temperature: number;
  feelsLike: number | null;
  humidity: number | null;
  windSpeed: number | null;
  code: number | null;
  isDay: boolean;
  precipitationProbability: number | null;
  hours: HourForecast[];
  days: DayForecast[];
};
