import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/constants/colors';

export function WeatherLoading() {
  return (
    <View accessibilityLabel="Loading weather forecast" accessibilityState={{ busy: true }} style={styles.container}>
      <View style={styles.status}><ActivityIndicator color={colors.primary} /><Text accessibilityLiveRegion="polite" style={styles.label}>Getting your forecast…</Text></View>
      <View style={styles.hero}><View style={[styles.line, { width: '40%' }]} /><View style={[styles.line, { width: '65%', height: 70 }]} /><View style={[styles.line, { width: '50%' }]} /></View>
      <View style={styles.card}><View style={[styles.line, { width: '40%' }]} /><View style={styles.hours}>{Array.from({ length: 6 }, (_, index) => <View key={index} style={styles.hour} />)}</View></View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 20 },
  status: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  label: { fontSize: 14, color: colors.mutedText },
  hero: { borderRadius: 24, backgroundColor: '#E1EAE5', padding: 30, gap: 24, minHeight: 280, justifyContent: 'center' },
  line: { height: 18, backgroundColor: '#CEDBD3', borderRadius: 8 },
  card: { borderRadius: 20, borderWidth: 1, borderColor: colors.border, padding: 24, gap: 24, backgroundColor: colors.surface },
  hours: { flexDirection: 'row', gap: 14 },
  hour: { flex: 1, height: 120, backgroundColor: colors.primarySoft, borderRadius: 12 },
});
