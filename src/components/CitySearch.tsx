import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '@/components/Button';
import { colors } from '@/constants/colors';
import { useCitySearch } from '@/hooks/useCitySearch';
import type { City } from '@/types/weather';

type Props = { onSelect: (city: City) => void };

export function CitySearch({ onSelect }: Props) {
  const { query, setQuery, cities, loading, error, retry } = useCitySearch();
  const active = query.trim().length >= 2;

  function select(city: City) {
    setQuery('');
    onSelect(city);
  }

  return (
    <View style={styles.container}>
      <Text nativeID="city-search-label" style={styles.label}>Find your forecast</Text>
      <View style={styles.inputRow}>
        <Text accessibilityElementsHidden importantForAccessibility="no" style={styles.searchIcon}>⌕</Text>
        <TextInput
          accessibilityLabel="Search for a city"
          accessibilityHint="Type at least two characters. Matching cities appear below."
          placeholder="Search a city or postal code…"
          placeholderTextColor={colors.mutedText}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="words"
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={() => { if (cities.length === 1) select(cities[0]); }}
          style={styles.input}
        />
        {query.length > 0 && (
          <Pressable accessibilityRole="button" accessibilityLabel="Clear city search" onPress={() => setQuery('')} style={styles.clear}>
            <Text style={styles.clearText}>×</Text>
          </Pressable>
        )}
      </View>
      {query.trim().length === 1 && <Text style={styles.hint}>Enter at least 2 characters to search.</Text>}
      {active && (
        <View style={styles.results}>
          {loading && <View style={styles.status}><ActivityIndicator color={colors.primary} /><Text accessibilityLiveRegion="polite" style={styles.hint}>Searching cities…</Text></View>}
          {error && <View style={styles.status}><Text accessibilityRole="alert" style={styles.error}>{error}</Text><Button label="Retry search" onPress={retry} secondary /></View>}
          {!loading && !error && cities.length === 0 && <Text accessibilityLiveRegion="polite" style={styles.hint}>No cities found. Try another name or a nearby city.</Text>}
          {!loading && !error && cities.length > 0 && <Text accessibilityLiveRegion="polite" style={styles.hint}>{cities.length} matching {cities.length === 1 ? 'city' : 'cities'}. Select a location.</Text>}
          {cities.map((city) => (
            <Pressable
              key={city.id}
              accessibilityRole="button"
              accessibilityLabel={`Show weather for ${[city.name, city.region, city.country].filter(Boolean).join(', ')}`}
              onPress={() => select(city)}
              style={({ pressed }) => [styles.result, pressed && styles.resultPressed]}
            >
              <View style={styles.resultLabel}>
                <Text style={styles.city}>{city.name}</Text>
                <Text style={styles.hint}>{[city.region, city.country].filter(Boolean).join(', ') || `${city.latitude.toFixed(2)}°, ${city.longitude.toFixed(2)}°`}</Text>
              </View>
              <Text style={styles.arrow}>↗</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 0, gap: 10 },
  label: { fontSize: 13, color: colors.mutedText, fontWeight: '600' },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, minHeight: 50 },
  searchIcon: { color: colors.primary, fontSize: 28, paddingLeft: 16 },
  input: { flex: 1, minWidth: 0, padding: 14, fontSize: 16, color: colors.text },
  clear: { minWidth: 44, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  clearText: { color: colors.mutedText, fontSize: 24 },
  results: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: 12, padding: 14, gap: 8 },
  result: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, padding: 10, borderRadius: 8, borderTopWidth: 1, borderTopColor: colors.border },
  resultPressed: { backgroundColor: colors.primarySoft },
  resultLabel: { flex: 1, gap: 4 },
  city: { fontSize: 16, color: colors.text, fontWeight: '600' },
  hint: { fontSize: 13, lineHeight: 20, color: colors.mutedText },
  status: { alignItems: 'flex-start', gap: 12 },
  error: { fontSize: 14, lineHeight: 22, color: colors.danger },
  arrow: { color: colors.primary, fontSize: 22 },
});
