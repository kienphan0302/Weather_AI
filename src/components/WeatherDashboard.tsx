import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { OutdoorPlanner } from '@/components/OutdoorPlanner';
import { colors } from '@/constants/colors';
import type { City, Weather } from '@/types/weather';
import { forecastDay, localTime, measurement, temperature, weatherCondition } from '@/utils/weather';

type Props = { weather: Weather; city: City; wide: boolean; compact: boolean };

function ConditionIcon({ code, isDay = true, large = false }: { code: number | null; isDay?: boolean; large?: boolean }) {
  const condition = weatherCondition(code, isDay);
  return <Text accessibilityLabel={condition.label} style={[styles.icon, large && styles.largeIcon]}>{condition.icon}</Text>;
}

function Metric({ label, value, note, symbol }: { label: string; value: string; note: string; symbol: string }) {
  return (
    <View style={styles.metric}>
      <View style={styles.metricHeading}><Text style={styles.metricSymbol} accessibilityElementsHidden importantForAccessibility="no">{symbol}</Text><Text style={styles.metricLabel}>{label}</Text></View>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricNote}>{note}</Text>
    </View>
  );
}

export function WeatherDashboard({ weather, city, wide, compact }: Props) {
  const condition = weatherCondition(weather.code, weather.isDay);
  const today = weather.days[0];
  const min = Math.min(...weather.days.flatMap((day) => day.min === null ? [] : [day.min]));
  const max = Math.max(...weather.days.flatMap((day) => day.max === null ? [] : [day.max]));
  const span = Math.max(1, max - min);
  return (
    <View style={styles.dashboard}>
      <View style={[styles.overview, wide && styles.overviewWide]}>
        <View style={[styles.hero, wide && styles.heroWide, compact && styles.heroCompact]}>
          <View style={styles.heroTop}>
            <View style={styles.liveBadge}><View style={styles.liveDot} /><Text style={styles.liveText}>CURRENT WEATHER</Text></View>
            <Text style={styles.heroSmall}>{weather.isDay ? 'Daytime' : 'Nighttime'}</Text>
          </View>
          <Text style={styles.heroDate}>{localTime(weather.observedAt, weather.timezone, 'date')}</Text>
          <View style={styles.heroMain}>
            <View style={styles.heroTemperatureGroup}>
              <Text accessibilityLabel={`${Math.round(weather.temperature)} degrees Celsius`} style={[styles.heroTemperature, compact && styles.heroTemperatureCompact]}>{temperature(weather.temperature)}<Text style={styles.celsius}>C</Text></Text>
              <Text style={styles.heroCondition}>{condition.label}</Text>
            </View>
            <View style={[styles.heroArt, compact && styles.heroArtCompact]}><ConditionIcon code={weather.code} isDay={weather.isDay} large /></View>
          </View>
          <View style={styles.heroBottom}>
            <Text style={styles.heroDetail}>Feels like {temperature(weather.feelsLike)}</Text>
            <Text style={styles.heroDetail}>H {temperature(today?.max)}  /  L {temperature(today?.min)}</Text>
          </View>
          <Text style={styles.heroFootnote}>Local time {localTime(weather.observedAt, weather.timezone, 'time')} · {city.name}</Text>
        </View>
        <View style={styles.metrics}>
          <Metric label="Feels like" value={temperature(weather.feelsLike)} note="Apparent temperature" symbol="◉" />
          <Metric label="Humidity" value={measurement(weather.humidity, '%')} note="Relative humidity" symbol="♧" />
          <Metric label="Wind speed" value={measurement(weather.windSpeed, ' km/h')} note="At 10 m above ground" symbol="≋" />
          <Metric label="Chance of rain" value={measurement(weather.precipitationProbability, '%')} note="This hour · rain or snow" symbol="☂" />
        </View>
      </View>

      <OutdoorPlanner key={`${city.latitude},${city.longitude}`} weather={weather} />

      <View style={styles.card}>
        <View style={styles.sectionHeading}>
          <View style={styles.sectionTitleGroup}><Text accessibilityRole="header" style={styles.sectionTitle}>Hourly forecast</Text><Text style={styles.subtitle}>A little foresight for your day</Text></View>
          <Text style={styles.tag}>NEXT 24 HOURS</Text>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.hourly} accessibilityLabel="24-hour forecast. Scroll horizontally for later hours.">
          {weather.hours.map((hour, index) => (
            <View key={hour.time} style={[styles.hour, index === 0 && styles.hourCurrent]}>
              <Text style={[styles.hourTime, index === 0 && styles.hourTimeCurrent]}>{index === 0 ? 'Now' : localTime(hour.time, weather.timezone, 'hour')}</Text>
              <ConditionIcon code={hour.code} isDay={hour.isDay} />
              <Text style={styles.hourTemperature}>{temperature(hour.temperature)}</Text>
              <Text accessibilityLabel={`Precipitation probability ${measurement(hour.precipitationProbability, '%')}`} style={styles.rain}>{measurement(hour.precipitationProbability, '%')}</Text>
            </View>
          ))}
        </ScrollView>
      </View>

      <View style={styles.card}>
        <View style={styles.sectionHeading}>
          <View style={styles.sectionTitleGroup}><Text accessibilityRole="header" style={styles.sectionTitle}>7-day forecast</Text><Text style={styles.subtitle}>Make room for what’s ahead</Text></View>
          <Text style={styles.tag}>°C · LOW / HIGH</Text>
        </View>
        {weather.days.map((day, index) => (
          <View key={day.time} style={styles.day}>
            <Text style={[styles.dayName, compact && styles.dayNameCompact]}>{index === 0 ? 'Today' : forecastDay(day.time, weather.utcOffsetSeconds)}</Text>
            <View style={styles.dayCondition}>
              <ConditionIcon code={day.code} />
              {!compact && <Text style={styles.dayDescription}>{weatherCondition(day.code).label}</Text>}
            </View>
            <Text accessibilityLabel={`Maximum precipitation probability ${measurement(day.precipitationProbability, '%')}`} style={styles.dayRain}>{measurement(day.precipitationProbability, '%')}</Text>
            <View style={[styles.rangeGroup, compact && styles.rangeGroupCompact]}>
              <Text accessibilityLabel={`Low ${temperature(day.min)}`} style={styles.low}>{temperature(day.min)}</Text>
              {!compact && <View style={styles.rangeTrack}>{day.min !== null && day.max !== null && <View style={[styles.rangeFill, { left: `${((day.min - min) / span) * 100}%`, width: `${Math.max(3, ((day.max - day.min) / span) * 100)}%` }]} />}</View>}
              <Text accessibilityLabel={`High ${temperature(day.max)}`} style={styles.high}>{temperature(day.max)}</Text>
            </View>
          </View>
        ))}
        <Text style={styles.forecastNote}>Percentages show precipitation probability. Times are local to the forecast location.</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dashboard: { gap: 24 },
  overview: { gap: 20 },
  overviewWide: { flexDirection: 'row', alignItems: 'stretch' },
  hero: { borderRadius: 24, padding: 28, backgroundColor: colors.primary, overflow: 'hidden' },
  heroWide: { flex: 1.1 },
  heroCompact: { padding: 22 },
  heroArtCompact: { width: 80, height: 80, borderRadius: 40 },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  liveText: { fontSize: 10, letterSpacing: 1.4, color: '#FFFFFF', fontWeight: '700' },
  heroSmall: { color: '#D6E8DF', fontSize: 12 },
  heroDate: { marginTop: 24, color: '#D6E8DF', fontSize: 14 },
  heroMain: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8, marginBottom: 24 },
  heroTemperatureGroup: { flexShrink: 1 },
  heroTemperature: { fontSize: 88, lineHeight: 106, letterSpacing: -5, color: '#FFFFFF', fontWeight: '300' },
  heroTemperatureCompact: { fontSize: 64, lineHeight: 80 },
  celsius: { fontSize: 28, letterSpacing: 0, color: '#D6E8DF' },
  heroCondition: { fontSize: 20, fontWeight: '500', color: '#FFFFFF' },
  heroArt: { width: 104, height: 104, borderRadius: 52, backgroundColor: '#326A59', justifyContent: 'center', alignItems: 'center' },
  heroBottom: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, paddingTop: 18, borderTopWidth: 1, borderTopColor: '#548270', justifyContent: 'space-between' },
  heroDetail: { color: '#FFFFFF', fontSize: 14 },
  heroFootnote: { color: '#D6E8DF', fontSize: 12, marginTop: 18 },
  metrics: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  metric: { flexGrow: 1, flexBasis: '45%', minWidth: 125, padding: 20, gap: 12, backgroundColor: colors.surface, borderRadius: 18, borderWidth: 1, borderColor: colors.border, justifyContent: 'center' },
  metricHeading: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  metricLabel: { color: colors.mutedText, fontSize: 13, fontWeight: '500' },
  metricSymbol: { color: colors.primary, fontSize: 19 },
  metricValue: { color: colors.text, fontSize: 28, fontWeight: '600', letterSpacing: -0.8 },
  metricNote: { color: colors.mutedText, fontSize: 11, lineHeight: 16 },
  card: { borderRadius: 20, padding: 22, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  sectionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 22 },
  sectionTitleGroup: { gap: 6 },
  sectionTitle: { fontSize: 20, fontWeight: '600', color: colors.text, letterSpacing: -0.4 },
  subtitle: { color: colors.mutedText, fontSize: 12 },
  tag: { color: colors.mutedText, fontSize: 10, letterSpacing: 1, fontWeight: '600' },
  hourly: { gap: 8, paddingBottom: 12 },
  hour: { width: 83, paddingVertical: 16, alignItems: 'center', gap: 13, borderRadius: 14 },
  hourCurrent: { backgroundColor: colors.primarySoft },
  hourTime: { fontSize: 12, color: colors.mutedText, fontWeight: '500' },
  hourTimeCurrent: { color: colors.primary, fontWeight: '700' },
  icon: { fontSize: 27, textAlign: 'center', color: '#B67917', minWidth: 36 },
  largeIcon: { fontSize: 66, lineHeight: 88 },
  hourTemperature: { fontSize: 22, color: colors.text, fontWeight: '600' },
  rain: { fontSize: 12, color: colors.primary },
  day: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, borderTopColor: colors.border },
  dayName: { width: 82, color: colors.text, fontSize: 14, fontWeight: '600' },
  dayNameCompact: { width: 48, fontSize: 13 },
  dayCondition: { flex: 1, flexDirection: 'row', gap: 12, alignItems: 'center' },
  dayDescription: { color: colors.mutedText, fontSize: 13, flexShrink: 1 },
  dayRain: { width: 42, textAlign: 'right', color: colors.primary, fontSize: 12 },
  rangeGroup: { flexDirection: 'row', gap: 12, flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
  rangeGroupCompact: { flex: 0, width: 80 },
  rangeTrack: { height: 6, borderRadius: 3, backgroundColor: colors.primarySoft, flex: 1, overflow: 'hidden' },
  rangeFill: { height: 6, borderRadius: 3, backgroundColor: '#D8AD55', position: 'absolute' },
  low: { width: 34, textAlign: 'right', color: colors.mutedText, fontSize: 14 },
  high: { width: 34, textAlign: 'right', color: colors.text, fontWeight: '600', fontSize: 14 },
  forecastNote: { marginTop: 16, fontSize: 11, lineHeight: 18, color: colors.mutedText },
});
