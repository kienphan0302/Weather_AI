import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@/constants/colors';

type EmptyStateProps = {
  title: string;
  message: string;
};

export function EmptyState({ title, message }: EmptyStateProps) {
  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      <Text style={styles.message}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: 12,
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '600',
    textAlign: 'center',
  },
  message: {
    color: colors.mutedText,
    fontSize: 16,
    textAlign: 'center',
  },
});
