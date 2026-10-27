export function weatherCondition(code: number | null, isDay = true) {
  if (code === 0) return { label: isDay ? 'Clear sky' : 'Clear night', icon: isDay ? '☀' : '☾' };
  if (code === 1) return { label: 'Mostly clear', icon: isDay ? '🌤' : '☾' };
  if (code === 2) return { label: 'Partly cloudy', icon: '⛅' };
  if (code === 3) return { label: 'Overcast', icon: '☁' };
  if (code === 45 || code === 48) return { label: 'Fog', icon: '🌫' };
  if (code !== null && [51, 53, 55, 56, 57].includes(code)) return { label: 'Drizzle', icon: '🌦' };
  if (code !== null && [61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { label: 'Rain', icon: '🌧' };
  if (code !== null && [71, 73, 75, 77, 85, 86].includes(code)) return { label: 'Snow', icon: '❄' };
  if (code !== null && [95, 96, 99].includes(code)) return { label: 'Thunderstorm', icon: '⛈' };
  return { label: 'Conditions unavailable', icon: '○' };
}

export function temperature(value: number | null | undefined) {
  return value == null ? '—' : `${Math.round(value)}°`;
}

export function measurement(value: number | null | undefined, unit: string) {
  return value == null ? '—' : `${Math.round(value)}${unit}`;
}

export function localTime(time: number, timezone: string, format: 'hour' | 'day' | 'date' | 'time') {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    ...(format === 'hour' ? { hour: 'numeric', hour12: true } : {}),
    ...(format === 'time' ? { hour: 'numeric', minute: '2-digit', hour12: true } : {}),
    ...(format === 'day' ? { weekday: 'short' } : {}),
    ...(format === 'date' ? { weekday: 'long', month: 'long', day: 'numeric' } : {}),
  };
  return new Intl.DateTimeFormat('en-US', options).format(new Date(time * 1000));
}

export function forecastDay(time: number, utcOffsetSeconds: number) {
  // Daily aggregation boundaries use the API's fixed offset, even across DST.
  // Hourly instants still use the IANA timezone through localTime.
  return localTime(time + utcOffsetSeconds, 'UTC', 'day');
}
