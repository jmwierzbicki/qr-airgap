/**
 * Profile transmisji i kalibracja.
 *
 * Kanał jest jednokierunkowy, więc nadajnik nie może "zapytać" odbiornika, co
 * działa. Zamiast tego w trybie kalibracji przelatuje po stałej tabeli profili,
 * każdy przez CALIBRATION_MS, a odbiornik mierzy, ile z każdego profilu realnie
 * odebrał. Obie strony muszą mieć identyczną tabelę, dlatego jest wersjonowana.
 *
 * Każdy profil z tabeli ma czytelną nazwę "Przymiotnik Zwierzę": zwierzę koduje
 * siatkę i rozmiar bloku, przymiotnik koduje fps i kodowanie.
 */

import { mulberry32 } from './bytes';

export type Grid = 1 | 2 | 4;

export interface Profile {
  /** Bajtów danych w jednym kodzie QR. */
  blockSize: number;
  /** Klatek (zestawów kodów) na sekundę. */
  fps: number;
  /** Ile kodów QR na jednej klatce. */
  grid: Grid;
  /** true = surowe bajty (wymaga ZXing), false = base64 (działa też z BarcodeDetector). */
  binary: boolean;
}

export const CALIBRATION_TABLE_VERSION = 1;
export const CALIBRATION_MS = 2500;

export const CALIBRATION_BLOCK_SIZES = [400, 700, 1000, 1400] as const;
export const CALIBRATION_FPS = [6, 10, 15] as const;
export const CALIBRATION_GRIDS: readonly Grid[] = [1, 2, 4];

const ANIMALS: Record<Grid, readonly string[]> = {
  1: ['Jeż', 'Bóbr', 'Borsuk', 'Lis'],
  2: ['Ryś', 'Wilk', 'Jeleń', 'Żubr'],
  4: ['Kruk', 'Sokół', 'Orzeł', 'Łoś'],
};

const ADJECTIVES: Record<'base64' | 'binary', readonly string[]> = {
  base64: ['Spokojny', 'Żwawy', 'Szybki'],
  binary: ['Cichy', 'Zwinny', 'Rączy'],
};

function buildTable(): Profile[] {
  const out: Profile[] = [];
  for (const grid of CALIBRATION_GRIDS) {
    for (const blockSize of CALIBRATION_BLOCK_SIZES) {
      for (const fps of CALIBRATION_FPS) {
        for (const binary of [false, true]) {
          out.push({ blockSize, fps, grid, binary });
        }
      }
    }
  }
  return out;
}

/** Stała tabela profili; indeks w tabeli jest identyfikatorem w ramkach kalibracyjnych. */
export const CALIBRATION_PROFILES: readonly Profile[] = buildTable();

export function profileName(p: Profile): string | null {
  const bi = CALIBRATION_BLOCK_SIZES.indexOf(p.blockSize as (typeof CALIBRATION_BLOCK_SIZES)[number]);
  const fi = CALIBRATION_FPS.indexOf(p.fps as (typeof CALIBRATION_FPS)[number]);
  if (bi < 0 || fi < 0 || !ANIMALS[p.grid]) return null;
  return `${ADJECTIVES[p.binary ? 'binary' : 'base64'][fi]} ${ANIMALS[p.grid][bi]}`;
}

function normalize(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const BY_NAME = new Map<string, Profile>(
  CALIBRATION_PROFILES.map((p) => [normalize(profileName(p)!), p]),
);

/** Wyszukiwanie po nazwie, nieczułe na wielkość liter i polskie znaki. */
export function profileByName(name: string): Profile | null {
  return BY_NAME.get(normalize(name)) ?? null;
}

export function profileIndex(p: Profile): number {
  return CALIBRATION_PROFILES.findIndex(
    (c) => c.blockSize === p.blockSize && c.fps === p.fps && c.grid === p.grid && c.binary === p.binary,
  );
}

export function sameProfile(a: Profile, b: Profile): boolean {
  return a.blockSize === b.blockSize && a.fps === b.fps && a.grid === b.grid && a.binary === b.binary;
}

/** Liczba kodów QR wysyłanych w jednym profilu podczas kalibracji. */
export function calibrationCodes(p: Profile): number {
  return Math.round((p.fps * CALIBRATION_MS) / 1000) * p.grid;
}

export function calibrationDurationMs(): number {
  return CALIBRATION_PROFILES.length * CALIBRATION_MS;
}

/**
 * Pseudolosowa (nieściśliwa) treść ramki kalibracyjnej: gęsty, "trudny" kod QR,
 * reprezentatywny dla spakowanych danych.
 */
export function calibrationPayload(profileIdx: number, seed: number, size: number): Uint8Array {
  const rand = mulberry32((profileIdx * 1_000_003 + seed) >>> 0);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

export const DEFAULT_PROFILE: Profile = { blockSize: 700, fps: 10, grid: 1, binary: false };
