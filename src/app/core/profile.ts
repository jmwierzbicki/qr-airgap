/**
 * Profile transmisji i kalibracja.
 *
 * Kanał jest jednokierunkowy, więc nadajnik nie może "zapytać" odbiornika, co
 * działa. Zamiast tego w trybie kalibracji przelatuje po stałej tabeli profili,
 * każdy przez CALIBRATION_MS, a odbiornik mierzy, ile z każdego profilu realnie
 * odebrał. Obie strony muszą mieć identyczną tabelę, dlatego jest wersjonowana.
 *
 * Tabela ma dwie części:
 *  - czarno-białą (binarną): siatka 1/2/4 × rozmiar bloku × fps,
 *  - kolorową (eksperyment): 3 kody w kanałach R/G/B, siatka 1/2 × blok × fps.
 * Kalibruje się wyłącznie w trybie binarnym (odbiornik sam przełącza się na
 * ZXing), bo base64 to tylko inna gęstość kodu, nie inna fizyka kamery.
 *
 * Każdy profil z tabeli ma czytelną nazwę "Przymiotnik Zwierzę": zwierzę koduje
 * siatkę i rozmiar bloku, przymiotnik koduje fps i to, czy profil jest kolorowy.
 */

import { mulberry32 } from './bytes';

export type Grid = 1 | 2 | 4;

export interface Profile {
  /** Bajtów danych w jednym kodzie QR. */
  blockSize: number;
  /** Klatek (zestawów kodów) na sekundę. */
  fps: number;
  /** Ile komórek z kodami na jednej klatce. */
  grid: Grid;
  /** true = surowe bajty (wymaga ZXing), false = base64 (działa też z BarcodeDetector). */
  binary: boolean;
  /** true = w każdej komórce trzy kody zmultipleksowane w kanałach R, G, B. */
  color: boolean;
}

export const CALIBRATION_TABLE_VERSION = 2;
export const CALIBRATION_MS = 2000;

export const CALIBRATION_BLOCK_SIZES = [400, 700, 1000, 1400] as const;
export const CALIBRATION_FPS = [6, 10, 15] as const;
export const CALIBRATION_GRIDS_BW: readonly Grid[] = [1, 2, 4];
export const CALIBRATION_GRIDS_COLOR: readonly Grid[] = [1, 2];

const ANIMALS: Record<Grid, readonly string[]> = {
  1: ['Jeż', 'Bóbr', 'Borsuk', 'Lis'],
  2: ['Ryś', 'Wilk', 'Jeleń', 'Żubr'],
  4: ['Kruk', 'Sokół', 'Orzeł', 'Łoś'],
};

const ADJECTIVES_BW = ['Spokojny', 'Żwawy', 'Szybki'] as const;
const ADJECTIVES_COLOR = ['Tęczowy', 'Barwny', 'Jaskrawy'] as const;

function buildTable(): { all: Profile[]; bwCount: number } {
  const all: Profile[] = [];
  for (const grid of CALIBRATION_GRIDS_BW) {
    for (const blockSize of CALIBRATION_BLOCK_SIZES) {
      for (const fps of CALIBRATION_FPS) {
        all.push({ blockSize, fps, grid, binary: true, color: false });
      }
    }
  }
  const bwCount = all.length;
  for (const grid of CALIBRATION_GRIDS_COLOR) {
    for (const blockSize of CALIBRATION_BLOCK_SIZES) {
      for (const fps of CALIBRATION_FPS) {
        all.push({ blockSize, fps, grid, binary: true, color: true });
      }
    }
  }
  return { all, bwCount };
}

const TABLE = buildTable();

/** Stała tabela profili; indeks w tabeli jest identyfikatorem w ramkach kalibracyjnych. */
export const CALIBRATION_PROFILES: readonly Profile[] = TABLE.all;
export const CALIBRATION_BW_COUNT = TABLE.bwCount;

export type CalibrationKind = 'bw' | 'color';

/** Zakres indeksów tabeli dla danego rodzaju kalibracji: [od, do). */
export function calibrationRange(kind: CalibrationKind): [number, number] {
  return kind === 'bw' ? [0, CALIBRATION_BW_COUNT] : [CALIBRATION_BW_COUNT, CALIBRATION_PROFILES.length];
}

export function profileName(p: Profile): string | null {
  if (!p.binary) return null;
  const bi = CALIBRATION_BLOCK_SIZES.indexOf(p.blockSize as (typeof CALIBRATION_BLOCK_SIZES)[number]);
  const fi = CALIBRATION_FPS.indexOf(p.fps as (typeof CALIBRATION_FPS)[number]);
  const grids = p.color ? CALIBRATION_GRIDS_COLOR : CALIBRATION_GRIDS_BW;
  if (bi < 0 || fi < 0 || !grids.includes(p.grid)) return null;
  const adjective = p.color ? ADJECTIVES_COLOR[fi] : ADJECTIVES_BW[fi];
  return `${adjective} ${ANIMALS[p.grid][bi]}`;
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
  return CALIBRATION_PROFILES.findIndex((c) => sameProfile(c, p));
}

export function sameProfile(a: Profile, b: Profile): boolean {
  return (
    a.blockSize === b.blockSize &&
    a.fps === b.fps &&
    a.grid === b.grid &&
    a.binary === b.binary &&
    a.color === b.color
  );
}

/** Kodów QR na jednej klatce. */
export function codesPerFrame(p: Profile): number {
  return p.grid * (p.color ? 3 : 1);
}

/** Liczba kodów QR wysyłanych w jednym profilu podczas kalibracji. */
export function calibrationCodes(p: Profile): number {
  return Math.round((p.fps * CALIBRATION_MS) / 1000) * codesPerFrame(p);
}

export function calibrationDurationMs(kind: CalibrationKind): number {
  const [from, to] = calibrationRange(kind);
  return (to - from) * CALIBRATION_MS;
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

export const DEFAULT_PROFILE: Profile = { blockSize: 700, fps: 10, grid: 1, binary: false, color: false };
