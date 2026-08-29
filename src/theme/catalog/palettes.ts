// The palettes Watchtower ships.
//
// A compatible subset of the source catalog: the five looks the operations
// pages seed with (Sky, Signal, Amber, Steel, Wine) plus four neutrals the
// Settings screen offers as alternatives. Colour values are carried over
// verbatim so a page renders exactly as it does in production.

import type { Palette } from './types';

export const WATCHTOWER_PALETTES: Palette[] = [
  {
    id: 'wine',
    name: 'Wine',
    group: 'hearth',
    blurb: 'The house palette. Warm parchment by day, pewter velvet by night.',
    light: {
      bg: '#EFE4D2', surface: '#E8DCC4', paper: '#FBF5E6',
      ink: '#2D1B26', inkSoft: '#4A2F3D', muted: '#6E5E40', line: '#DDCBA8',
      rust: '#5C2A4A', rustDark: '#3F1A33', rustLight: '#7A3F60', champagne: '#8A6E30',
    },
    dark: {
      bg: '#20212A', surface: '#262732', paper: '#2E2F38',
      ink: '#F5EFE3', inkSoft: '#E0D8C8', muted: '#A6A4AE', line: '#3A3B45',
      rust: '#C77AA0', rustDark: '#9E5C84', rustLight: '#DCA5C4', champagne: '#DCB87A',
    },
  },
  {
    id: 'sky',
    name: 'Sky',
    group: 'hearth',
    blurb: 'Periwinkle. Cloud infrastructure, appropriately.',
    light: {
      bg: '#E6EEFA', surface: '#D6E2F5', paper: '#F2F6FD',
      ink: '#14213A', inkSoft: '#263C5E', muted: '#4C6288', line: '#C5D5EF',
      rust: '#1F51A8', rustDark: '#153A7C', rustLight: '#3670CA', champagne: '#1A5E78',
    },
    dark: {
      bg: '#101827', surface: '#152034', paper: '#1B2940',
      ink: '#E4ECF8', inkSoft: '#C6D6EC', muted: '#8CA0BF', line: '#273750',
      rust: '#4E8AF0', rustDark: '#2E67C8', rustLight: '#7FAEF7', champagne: '#A6C4E6',
    },
  },
  {
    id: 'signal',
    name: 'Signal',
    group: 'hearth',
    blurb: 'Cyan over cool slate. Link lights, throughput and grid paper.',
    light: {
      bg: '#E4EEF2', surface: '#D3E4EA', paper: '#F0F7F9',
      ink: '#0E2229', inkSoft: '#1C3D48', muted: '#456A76', line: '#BCD8E0',
      rust: '#0C6D8C', rustDark: '#084F66', rustLight: '#2B8CAC', champagne: '#0F7361',
    },
    dark: {
      bg: '#0C1A20', surface: '#11242C', paper: '#162E37',
      ink: '#E8F6FA', inkSoft: '#CDE7EF', muted: '#95B8C2', line: '#2A4A55',
      rust: '#3FBEE2', rustDark: '#1E8FB4', rustLight: '#6FD8F5', champagne: '#6FE0C6',
    },
  },
  {
    id: 'amber',
    name: 'Amber',
    group: 'hearth',
    blurb: 'Charged gold on charcoal. Power and anything with a meter.',
    light: {
      bg: '#EEE9E0', surface: '#E1D9CB', paper: '#F8F4EC',
      ink: '#2A2418', inkSoft: '#46402C', muted: '#6B6350', line: '#D8CDB6',
      rust: '#8A6612', rustDark: '#6B4E0B', rustLight: '#AD8526', champagne: '#556E28',
    },
    dark: {
      bg: '#1A1813', surface: '#23201A', paper: '#2B2820',
      ink: '#F3EEDF', inkSoft: '#E0D8C2', muted: '#ABA184', line: '#3B372B',
      rust: '#E5B84A', rustDark: '#B8912E', rustLight: '#F5D06E', champagne: '#9FBF63',
    },
  },
  {
    id: 'steel',
    name: 'Steel',
    group: 'hearth',
    blurb: 'Gunmetal with a warning red. For the pages that can break things.',
    light: {
      bg: '#E7E9EC', surface: '#D6DAE0', paper: '#F2F3F5',
      ink: '#1A1E24', inkSoft: '#313640', muted: '#535A66', line: '#C7CCD4',
      rust: '#93302B', rustDark: '#72231F', rustLight: '#B24A44', champagne: '#4E5A68',
    },
    dark: {
      bg: '#14171B', surface: '#191D23', paper: '#20252C',
      ink: '#E6E9EE', inkSoft: '#C9CED6', muted: '#8E96A2', line: '#2B313A',
      rust: '#D45852', rustDark: '#A83A35', rustLight: '#E87A74', champagne: '#9AA6B4',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    group: 'hearth',
    blurb: 'Deep navy at night, crisp cool blue by day. High contrast either way.',
    light: {
      bg: '#DAE5F0', surface: '#C9D8E7', paper: '#F4F8FC',
      ink: '#111A24', inkSoft: '#2C3947', muted: '#4B5A6A', line: '#BCCDDD',
      rust: '#155CA8', rustDark: '#0E437C', rustLight: '#3376C4', champagne: '#0F7061',
    },
    dark: {
      bg: '#0A0F1A', surface: '#101827', paper: '#172136',
      ink: '#F2F6FF', inkSoft: '#D0DCF0', muted: '#9FB0CA', line: '#2A3853',
      rust: '#5AA9F0', rustDark: '#2F7FCC', rustLight: '#8CC6FA', champagne: '#7FE0D4',
    },
  },
  {
    id: 'scholar',
    name: 'Scholar',
    group: 'hearth',
    blurb: 'Academic navy on chalk. Built for long sessions.',
    light: {
      bg: '#E5E8EC', surface: '#D4DAE1', paper: '#F1F3F6',
      ink: '#17202B', inkSoft: '#2A3A4C', muted: '#4C5A6B', line: '#C3CCD6',
      rust: '#25506F', rustDark: '#1A3C54', rustLight: '#3C6C90', champagne: '#7A5E24',
    },
    dark: {
      bg: '#121820', surface: '#17202B', paper: '#1D2833',
      ink: '#E4E9EF', inkSoft: '#C8D2DC', muted: '#8E9CAC', line: '#2A3946',
      rust: '#4C82B8', rustDark: '#315F8C', rustLight: '#74A6D8', champagne: '#CBA968',
    },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    group: 'hearth',
    blurb: 'The one true neutral — no colour cast at all, warmed only by the accent.',
    light: {
      bg: '#E5E4DF', surface: '#D9D8D2', paper: '#FAFAF8',
      ink: '#1D1D1B', inkSoft: '#393937', muted: '#595954', line: '#CFCEC8',
      rust: '#B4442B', rustDark: '#8C3320', rustLight: '#D4694E', champagne: '#8A6530',
    },
    dark: {
      bg: '#121212', surface: '#1B1B1B', paper: '#242424',
      ink: '#F5F5F5', inkSoft: '#DADADA', muted: '#ABABAB', line: '#3A3A3A',
      rust: '#E0654A', rustDark: '#B84A33', rustLight: '#F08C74', champagne: '#E6B77A',
    },
  },
  {
    id: 'contrast',
    name: 'High Contrast',
    group: 'hearth',
    blurb: 'Maximum legibility. Pure black or pure white, heavy rules, amber accent.',
    light: {
      bg: '#FDFAF2', surface: '#F0EBDD', paper: '#FFFFFF',
      ink: '#141210', inkSoft: '#33302A', muted: '#55504A', line: '#E2DCCC',
      rust: '#8F6410', rustDark: '#6E4D09', rustLight: '#B58326', champagne: '#556E28',
    },
    dark: {
      bg: '#000000', surface: '#0C0C0C', paper: '#151515',
      ink: '#FFFFFF', inkSoft: '#EDEDED', muted: '#C8C8C8', line: '#555555',
      rust: '#E6A63A', rustDark: '#B87F1E', rustLight: '#F5C463', champagne: '#9FBF63',
    },
  },
];
