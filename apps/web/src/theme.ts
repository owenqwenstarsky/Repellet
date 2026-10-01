import type { editor } from 'monaco-editor';
// Keep in sync with styles/tokens.css (tests/layout.test.ts checks parity).
export const palette = {
  bg: '#141619',
  bgInset: '#111417',
  panel: '#17191d',
  surface: '#1b1e23',
  raised: '#20232a',
  statusbar: '#152029',
  border: '#292d34',
  borderStrong: '#353a43',
  textStrong: '#e0e4eb',
  text: '#d6dae2',
  textSecondary: '#b9c0cc',
  textMuted: '#9aa3b0',
  textSubtle: '#8a94a1',
  accent: '#88bbc4',
  accentHover: '#a0cad1',
  accentText: '#a3c4cc',
  onAccent: '#122529',
  selection: '#31444d',
  success: '#86b19a',
  warning: '#c9ad7b',
  danger: '#d09595',
  dangerSolid: '#b05a5a',
} as const;
export const syntax = {
  comment: '#8992a0',
  keyword: '#baa2d2',
  string: '#a1be8d',
  number: '#d2ac7e',
  type: '#8abec9',
  blue: '#8eb0d4',
  red: '#d58c8c',
} as const;
export const fonts = {
  mono: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
} as const;
const hex = (color: string) => color.slice(1).toUpperCase();
export const monacoTheme: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: hex(syntax.comment) },
    { token: 'keyword', foreground: hex(syntax.keyword) },
    { token: 'string', foreground: hex(syntax.string) },
    { token: 'number', foreground: hex(syntax.number) },
    { token: 'type', foreground: hex(syntax.type) },
  ],
  colors: {
    'editor.background': palette.panel,
    'editor.foreground': '#cbd0d9',
    'editorLineNumber.foreground': syntax.comment,
    'editorLineNumber.activeForeground': '#abb3bf',
    'editor.selectionBackground': palette.selection,
    'editor.inactiveSelectionBackground': '#2b343d',
    'editor.lineHighlightBackground': '#1d2026',
    'editorCursor.foreground': palette.accent,
    'editorIndentGuide.background1': '#282c33',
    'editorWidget.background': palette.raised,
    'editorWidget.border': palette.borderStrong,
  },
};
export const xtermTheme = {
  background: palette.bg,
  foreground: '#bdc3cf',
  cursor: palette.accent,
  selectionBackground: palette.selection,
  black: '#181b20',
  red: syntax.red,
  green: syntax.string,
  yellow: syntax.number,
  blue: syntax.blue,
  magenta: syntax.keyword,
  cyan: palette.accent,
  white: '#cbd0d9',
};
