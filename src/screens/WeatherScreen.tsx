import { Link } from 'expo-router';
import { Head } from 'expo-router/head';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { CitySearch } from '@/components/CitySearch';
import { EmptyState } from '@/components/EmptyState';
import { WeatherDashboard } from '@/components/WeatherDashboard';
import { WeatherLoading } from '@/components/WeatherLoading';
import { colors } from '@/constants/colors';
import { useLocation } from '@/hooks/useLocation';
import { useWeather } from '@/hooks/useWeather';

export default function WeatherScreen() {
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const compact = width < 580;
  const { city, selectCity, locate, locating, locationError } = useLocation();
  const { weather, loading, error, refresh } = useWeather(city);
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
      <Head><title>Weather — Your daily outlook</title><meta name="description" content="A clear view of your day. Current weather, hourly forecasts and a 7-day outlook for cities around the world." /></Head>
      <ScrollView contentContainerStyle={[styles.page, compact && styles.pageCompact]} keyboardShouldPersistTaps="handled">
        <View style={styles.content}>
          <View style={styles.header}>
            <View style={styles.brand}><View style={styles.brandMark}><Text accessibilityElementsHidden importantForAccessibility="no" style={styles.brandIcon}>☀</Text></View><Text style={styles.brandName}>weather<Text style={styles.brandDot}>.</Text></Text></View>
            <Text style={styles.headerNote}>A clearer day ahead.</Text>
          </View>
          <View style={[styles.searchRow, compact && styles.searchRowCompact]}>
            <CitySearch onSelect={selectCity} />
            <View style={!compact && styles.locationButton}><Button label={locating ? 'Finding location…' : '◎  Use my location'} accessibilityLabel="Use my current location" onPress={locate} busy={locating} secondary /></View>
          </View>
          {locationError && <View style={styles.notice}><Text accessibilityRole="alert" style={styles.noticeText}>{locationError} Keeping the selected city.</Text></View>}
          <View style={styles.heading}>
            <View style={styles.headingText}>
              <Text style={styles.eyebrow}>YOUR DAILY OUTLOOK</Text>
              <Text accessibilityRole="header" style={[styles.cityTitle, compact && styles.cityTitleCompact]}>{city.name}</Text>
              <Text style={styles.region}>{[city.region, city.country].filter(Boolean).join(', ') || `${city.latitude.toFixed(2)}°, ${city.longitude.toFixed(2)}°`}</Text>
            </View>
            <Button label={loading && weather ? 'Updating…' : '↻  Refresh'} accessibilityLabel="Refresh weather forecast" onPress={refresh} busy={loading} secondary />
          </View>
          {error && (
            <View style={styles.error}>
              <Text accessibilityRole="alert" style={styles.errorText}>{weather ? 'Could not refresh. Showing the last loaded forecast. ' : ''}{error}</Text>
              <Button label="Try again" onPress={refresh} busy={loading} secondary />
            </View>
          )}
          {loading && !weather && <WeatherLoading />}
          {weather && <WeatherDashboard weather={weather} city={city} wide={wide} compact={compact} />}
          {!weather && !loading && <View style={styles.empty}><EmptyState title="Forecast unavailable" message="Try again above, or search for another city to see its forecast." /></View>}
          <View style={styles.footer}>
            <View style={styles.footerInfo}>
              <Text style={styles.footerText}>{weather ? `Retrieved ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(weather.fetchedAt)} · Auto-refreshes every 10 minutes` : 'Your forecast, wherever you are.'}</Text>
              <Text style={styles.footerText}>Celsius · Wind in km/h</Text>
            </View>
            <Link href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer" style={styles.credit}>Weather data by Open-Meteo ↗</Link>
            <Link href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer" style={styles.credit}>City data by GeoNames ↗</Link>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  page: { paddingHorizontal: 40, paddingBottom: 32, flexGrow: 1 },
  pageCompact: { paddingHorizontal: 16 },
  content: { width: '100%', maxWidth: 1120, alignSelf: 'center', gap: 26 },
  header: { minHeight: 94, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  brand: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  brandMark: { height: 34, width: 34, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  brandIcon: { color: colors.accent, fontSize: 24 },
  brandName: { fontSize: 27, fontWeight: '700', letterSpacing: -1, color: colors.text },
  brandDot: { color: colors.primary },
  headerNote: { fontSize: 12, color: colors.mutedText, flexShrink: 1, textAlign: 'right' },
  searchRow: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  searchRowCompact: { flexDirection: 'column', alignItems: 'stretch' },
  locationButton: { marginTop: 26 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 8 },
  headingText: { gap: 8, flex: 1 },
  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 2, color: colors.primary },
  cityTitle: { color: colors.text, fontSize: 40, fontWeight: '600', letterSpacing: -1.4 },
  cityTitleCompact: { fontSize: 30 },
  region: { color: colors.mutedText, fontSize: 14, lineHeight: 20 },
  notice: { padding: 16, borderRadius: 12, backgroundColor: '#FFF3D7' },
  noticeText: { fontSize: 14, lineHeight: 22, color: '#6C5019' },
  error: { padding: 18, borderRadius: 14, borderWidth: 1, borderColor: '#ECCCBF', backgroundColor: colors.dangerSoft, gap: 14, alignItems: 'flex-start' },
  errorText: { color: colors.danger, fontSize: 14, lineHeight: 22 },
  empty: { padding: 40, borderRadius: 20, backgroundColor: colors.surface },
  footer: { paddingTop: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 14, justifyContent: 'space-between' },
  footerInfo: { gap: 6 },
  footerText: { color: colors.mutedText, fontSize: 11, lineHeight: 18 },
  credit: { color: colors.primary, fontSize: 11, textDecorationLine: 'underline', paddingVertical: 10 },
});
