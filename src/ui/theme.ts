import { Platform, useColorScheme } from 'react-native';
import { usePrefs, type FontFamily } from './prefs';

const light = {
  bg: '#FAF7F2',
  surface: '#FFFFFF',
  text: '#1F1B16',
  muted: '#6B6359',
  border: '#E6DFD4',
  accent: '#B5532A',
  accentText: '#FFFFFF',
  highlight: '#F6E2B3',
  word: '#E9B949',
  danger: '#B3261E',
  dark: false,
};

export type Theme = typeof light;

const sepia: Theme = {
  bg: '#F4ECD8',
  surface: '#FBF5E6',
  text: '#3B2F22',
  muted: '#7A6A55',
  border: '#E2D5B8',
  accent: '#9A4A22',
  accentText: '#FFFFFF',
  highlight: '#EBD49A',
  word: '#D9A93A',
  danger: '#9E2A1E',
  dark: false,
};

const dark: Theme = {
  bg: '#141210',
  surface: '#1E1B18',
  text: '#EDE6DC',
  muted: '#A39A8E',
  border: '#332E28',
  accent: '#E08A5F',
  accentText: '#1A120D',
  highlight: '#4A3B1E',
  word: '#8A6A1E',
  danger: '#F2B8B5',
  dark: true,
};

export function useTheme(): Theme {
  const system = useColorScheme();
  const { theme } = usePrefs();
  if (theme === 'light') return light;
  if (theme === 'sepia') return sepia;
  if (theme === 'dark') return dark;
  return system === 'dark' ? dark : light;
}

export function fontFor(family: FontFamily) {
  if (family === 'sans') return undefined;
  return Platform.select({ ios: 'Georgia', android: 'serif', default: undefined });
}
