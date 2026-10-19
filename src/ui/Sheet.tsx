import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from './theme';

export function Sheet({
  visible,
  title,
  onClose,
  children,
  tall,
  action,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  tall?: boolean;
  // Primary button shown next to the title, so it stays reachable while the keyboard is open.
  action?: { label: string; onPress: () => void; disabled?: boolean; testID?: string };
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Kapat" />
        <View
          style={[
            styles.card,
            { backgroundColor: t.surface, paddingBottom: Math.max(insets.bottom, 16), borderColor: t.border },
            tall && { height: '85%' },
          ]}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: t.text, flex: 1 }]} numberOfLines={1}>
              {title}
            </Text>
            {action ? (
              <Pressable
                onPress={action.onPress}
                disabled={action.disabled}
                accessibilityRole="button"
                testID={action.testID}
                style={({ pressed }) => [styles.action, { backgroundColor: t.accent, opacity: pressed || action.disabled ? 0.6 : 1 }]}
              >
                <Text style={{ color: t.accentText, fontWeight: '700', fontSize: 15 }}>{action.label}</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Kapat" testID="sheet-close">
              <Ionicons name="close" size={24} color={t.muted} />
            </Pressable>
          </View>
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.35)' },
  card: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 12 },
  action: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 18 },
  title: { fontSize: 19, fontWeight: '700' },
});
