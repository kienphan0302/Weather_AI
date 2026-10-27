import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { colors } from '@/constants/colors';

type Props = {
  label: string;
  onPress: () => void;
  busy?: boolean;
  secondary?: boolean;
  accessibilityLabel?: string;
};

export function Button({ label, onPress, busy = false, secondary = false, accessibilityLabel }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, secondary && styles.secondary, (pressed || busy) && styles.pressed]}
    >
      {busy && <ActivityIndicator size="small" color={secondary ? colors.primary : colors.surface} />}
      <Text style={[styles.label, secondary && styles.secondaryLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 46, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 12, backgroundColor: colors.primary, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  label: { color: colors.surface, fontWeight: '600', fontSize: 14 },
  secondaryLabel: { color: colors.primary },
  pressed: { opacity: 0.65 },
});
