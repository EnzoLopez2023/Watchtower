// Optional accent overrides.
//
// Every palette already ships with its own accent ramp, so this list is not
// part of the normal flow — it exists for the case where someone wants one
// palette's neutrals with another's accent. Off by default; the appearance
// picker shows "Palette default" as the first option.

import type { AccentDef } from './types';

export const ACCENTS: AccentDef[] = [
  {
    id: 'ember', name: 'Ember',
    dark: { rust: '#E0654A', rustDark: '#B84A33', rustLight: '#F08C74', champagne: '#E6B77A' },
    light: { rust: '#B4442B', rustDark: '#8C3320', rustLight: '#D4694E', champagne: '#8A6530' },
  },
  {
    id: 'amber', name: 'Amber',
    dark: { rust: '#E6A63A', rustDark: '#B87F1E', rustLight: '#F5C463', champagne: '#9FBF63' },
    light: { rust: '#8F6410', rustDark: '#6E4D09', rustLight: '#B58326', champagne: '#556E28' },
  },
  {
    id: 'cyan', name: 'Cyan',
    dark: { rust: '#3FBEE2', rustDark: '#1E8FB4', rustLight: '#6FD8F5', champagne: '#6FE0C6' },
    light: { rust: '#0C6D8C', rustDark: '#084F66', rustLight: '#2B8CAC', champagne: '#0F7361' },
  },
  {
    id: 'teal', name: 'Teal',
    dark: { rust: '#3BC7B0', rustDark: '#1F9484', rustLight: '#69DECB', champagne: '#7FD1E8' },
    light: { rust: '#0D6E61', rustDark: '#095248', rustLight: '#268C7C', champagne: '#175E78' },
  },
  {
    id: 'emerald', name: 'Emerald',
    dark: { rust: '#4ACB7D', rustDark: '#2A9A57', rustLight: '#76E3A0', champagne: '#C8D96A' },
    light: { rust: '#186B3B', rustDark: '#11502C', rustLight: '#2E8650', champagne: '#5C6E1E' },
  },
  {
    id: 'violet', name: 'Violet',
    dark: { rust: '#A78BFA', rustDark: '#7C5CE0', rustLight: '#C4B0FF', champagne: '#F0A6C8' },
    light: { rust: '#6234C4', rustDark: '#4A2796', rustLight: '#7D53DC', champagne: '#9E3264' },
  },
  {
    id: 'coral', name: 'Coral',
    dark: { rust: '#FF8A6B', rustDark: '#D85B3E', rustLight: '#FFB09A', champagne: '#FFD08A' },
    light: { rust: '#B24327', rustDark: '#8A311B', rustLight: '#CE5F42', champagne: '#966C1C' },
  },
  {
    id: 'sky', name: 'Sky',
    dark: { rust: '#5AA9F0', rustDark: '#2F7FCC', rustLight: '#8CC6FA', champagne: '#7FE0D4' },
    light: { rust: '#155CA8', rustDark: '#0E437C', rustLight: '#3376C4', champagne: '#0F7061' },
  },
];

const BY_ID = new Map(ACCENTS.map((a) => [a.id, a]));

export const accentById = (id?: string): AccentDef | undefined => (id ? BY_ID.get(id) : undefined);
