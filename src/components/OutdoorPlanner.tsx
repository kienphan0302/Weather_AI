import { useEffect, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/constants/colors';
import { outdoorActivities, outdoorDurations, outdoorProfiles } from '@/constants/outdoor';
import type { OutdoorActivity, OutdoorDuration, PhotographyPreference } from '@/types/outdoor';
import type { Weather } from '@/types/weather';
import { daylightLabel, formatOutdoorWindow, rankOutdoorWindows } from '@/utils/outdoor';

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected }}
      aria-pressed={selected} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={({ pressed }) => [styles.option, selected && styles.selected, focused && styles.focused, pressed && styles.pressed]}>
      <Text style={styles.optionText}>{label}</Text>
    </Pressable>
  );
}

export function OutdoorPlanner({ weather }: { weather: Weather }) {
  const [activity, setActivity] = useState<OutdoorActivity>('Walking');
  const [photographyPreference, setPhotographyPreference] = useState<PhotographyPreference>('Daylight photos');
  const [duration, setDuration] = useState<OutdoorDuration>(1);
  const [clock, setClock] = useState(() => Date.now());
  const updateClock = () => setClock(Date.now());
  const now = clock / 1000;
  const windows = rankOutdoorWindows(weather.hours, weather.days, weather.timezone, activity, duration, now, weather.utcOffsetSeconds, photographyPreference);
  const daylightOnly = activity === 'Photography' && photographyPreference === 'Daylight photos';
  const scoreLabel = activity === 'Photography' ? 'Weather conditions score' : 'Suitability';
  const profile = outdoorProfiles[activity];
  const missingWind = weather.hours.some((hour) => hour.time > now && (hour.windSpeed == null || !Number.isFinite(hour.windSpeed) || hour.windSpeed < 0));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      const current = Date.now();
      setClock(current);
      clearTimeout(timer);
      const next = Math.min(...weather.hours.filter((hour) => hour.time * 1000 > current).map((hour) => hour.time));
      // Check clock adjustments at least every 30 seconds and expire starts at
      // their boundary. Re-evaluate immediately after a forecast or city change.
      timer = setTimeout(update, Math.max(1, Math.min(30000, next * 1000 - current)));
    };
    timer = setTimeout(update, 0);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') update(); });
    if (Platform.OS === 'web') {
      window.addEventListener('focus', update);
      document.addEventListener('visibilitychange', update);
    }
    return () => {
      clearTimeout(timer);
      subscription.remove();
      if (Platform.OS === 'web') {
        window.removeEventListener('focus', update);
        document.removeEventListener('visibilitychange', update);
      }
    };
  }, [weather.hours]);

  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>Weather Intelligence V3</Text>
      <Text style={styles.note}>Smart Outdoor Planner: up to three distinct, non-overlapping future windows in this 24-hour forecast. Times in {weather.timezone}.</Text>
      <Text style={styles.label}>Activity</Text>
      <View style={styles.options}>
        {outdoorActivities.map((option) => <Choice key={option} label={option} selected={activity === option}
          onPress={() => { setActivity(option); updateClock(); }} />)}
      </View>
      {activity === 'Photography' && <>
        <Text style={styles.label}>Photography preference</Text>
        <View style={styles.options}>
          {(['Daylight photos', 'Any time'] as const).map((option) => <Choice key={option} label={option}
            selected={photographyPreference === option} onPress={() => { setPhotographyPreference(option); updateClock(); }} />)}
        </View>
        <Text style={styles.note}>{daylightOnly
          ? 'Daylight photos requires the entire interval to be verified between destination sunrise and sunset. Unverified intervals are omitted. If solar coverage is unavailable or ambiguous, refresh above, change city or duration, or select Any time.'
          : 'Any time allows eligible night and unverified-light windows. Each result passes the weather checks; daylight is not required.'} Light quality, visibility, and night-photography suitability are not assessed.</Text>
      </>}
      <Text style={styles.label}>Consecutive hours</Text>
      <View style={styles.options}>
        {outdoorDurations.map((option) => <Choice key={option} label={`${option} hour${option === 1 ? '' : 's'}`} selected={duration === option}
          onPress={() => { setDuration(option); updateClock(); }} />)}
      </View>
      <Text style={styles.note}>{activity} comfort: {profile.min}–{profile.max}°C and wind up to {profile.windComfort} km/h. Temperature / precipitation / wind weights: {profile.weights.temperature} / {profile.weights.precipitation} / {profile.weights.wind} points.</Text>
      {missingWind && <Text style={styles.note}>Hourly wind is missing for some future hours. Those hours cannot be ranked; no wind values are estimated.</Text>}
      <Text accessibilityLiveRegion="polite" style={styles.label}>{windows.length ? `${windows.length} recommendations for ${activity.toLowerCase()}, ${duration} hour${duration === 1 ? '' : 's'}${activity === 'Photography' ? ` · ${photographyPreference}` : ''}` : (daylightOnly ? 'No verified daylight window' : 'No complete suitable window')}</Text>
      {windows.length === 0 && <Text style={styles.empty}>{daylightOnly ? 'No complete future window passes both the weather checks and verified sunrise–sunset coverage. Solar data may be missing, invalid, ambiguous, or not cover the interval. Try a shorter duration, refresh above, change city, or select Any time.' : 'No complete future window passes the data and weather checks. Try a shorter duration, refresh above, or choose another city.'}</Text>}
      {windows.map((result, index) => (
        <View key={result.start} style={styles.result}>
          <View style={styles.resultHeading}>
            <Text style={styles.rank}>#{index + 1} · {activity}</Text>
            <Text style={styles.score} accessibilityLabel={`${scoreLabel} ${result.score.total.toFixed(1)} out of 100`}>{scoreLabel}: {result.score.total.toFixed(1)} / 100</Text>
          </View>
          <Text style={styles.time}>{formatOutdoorWindow(result, weather.timezone)}</Text>
          <Text style={styles.note}>{daylightLabel(result.daylight)}</Text>
          <Text style={styles.values}>{result.temperatureMin.toFixed(1)}–{result.temperatureMax.toFixed(1)}°C · Rain/snow probability up to {result.precipitationMax.toFixed(0)}% · Wind {result.windMin.toFixed(1)}–{result.windMax.toFixed(1)} km/h</Text>
          <Text style={styles.note}>Average points: temperature {result.score.temperature.toFixed(1)}/{profile.weights.temperature}, precipitation {result.score.precipitation.toFixed(1)}/{profile.weights.precipitation}, wind {result.score.wind.toFixed(1)}/{profile.weights.wind}.</Text>
        </View>
      ))}
      <Text style={styles.note}>How scores work: temperature loses 10% of its weight per °C outside the comfort range. Precipitation earns its weight × (1 − hourly probability / 100). Wind loses 5% of its weight per km/h above the comfort speed. Each factor stops at zero; hourly points are averaged over the window.</Text>
      <Text style={styles.note}>Freezing precipitation, heavy rain/snow/showers, thunderstorms, unknown weather codes, temperatures ≤ −20°C or ≥ 40°C, and wind ≥ 50 km/h are excluded. Lower scores may still be poor conditions. Daylight does not affect the score; photography lighting and visibility are not assessed.</Text>
      <Text style={styles.note}>Scores are heuristic forecast-based comparisons, not probabilities or safety assurances. Hourly samples approximate conditions throughout each hour. Check local alerts, UV, gusts and conditions before going out. Refresh above if this forecast is old.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 20, padding: 20, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 14 },
  title: { fontSize: 20, fontWeight: '600', color: colors.text },
  label: { fontSize: 14, fontWeight: '600', color: colors.text },
  note: { color: colors.mutedText, fontSize: 12, lineHeight: 19 },
  values: { color: colors.text, fontSize: 13, lineHeight: 21 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: { minHeight: 48, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 2, borderColor: colors.border, borderRadius: 12, justifyContent: 'center' },
  optionText: { fontSize: 14, fontWeight: '600', color: colors.primary },
  selected: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  focused: { borderColor: colors.text, outlineStyle: 'solid', outlineWidth: 2, outlineOffset: 2 },
  pressed: { opacity: 0.65 },
  result: { padding: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 14, gap: 8 },
  resultHeading: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 },
  rank: { fontSize: 13, fontWeight: '600', color: colors.primary },
  score: { flexShrink: 1, fontSize: 15, fontWeight: '700', color: colors.primary },
  time: { fontSize: 14, fontWeight: '600', lineHeight: 22, color: colors.text },
  empty: { padding: 16, borderRadius: 12, backgroundColor: colors.primarySoft, color: colors.text, fontSize: 14, lineHeight: 22 },
});
