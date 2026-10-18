import { useColorScheme } from 'react-native';

const light = {
  bg: '#FAF7F2',
  surface: '#FFFFFF',
  text: '#1F1B16',
  muted: '#6B6359',
  border: '#E6DFD4',
  accent: '#B5532A',
  accentText: '#FFFFFF',
  highlight: '#F6E2B3',
  danger: '#B3261E',
};

const dark: typeof light = {
  bg: '#141210',
  surface: '#1E1B18',
  text: '#EDE6DC',
  muted: '#A39A8E',
  border: '#332E28',
  accent: '#E08A5F',
  accentText: '#1A120D',
  highlight: '#4A3B1E',
  danger: '#F2B8B5',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}
