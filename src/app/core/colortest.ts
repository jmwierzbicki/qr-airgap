/**
 * Pomiar przydatności kanału ekran→kamera do multipleksowania w kolorze.
 *
 * Nadajnik pokazuje kartę testową: zwykły (czarno-biały) kod QR jako kotwicę
 * geometryczną, obok osiem pól K/R/G/B/C/M/Y/W oraz paski o szerokości
 * 1–4 modułów w dwóch wariantach: luminancji (czarny/biały) i czystej
 * chrominancji (niebieski vs szary o tej samej luminancji). Odbiornik z
 * położenia kodu QR (4 narożniki) wyznacza homografię i próbkuje pola:
 *
 * - **marginesy separacji** kanałów R, G, B po normalizacji czernią i bielą:
 *   ile "miejsca" zostaje na próg między modułem zapalonym a zgaszonym;
 * - **macierz przenikania** (ile kanał G widzi z czystej czerwieni itd.);
 * - **kontrast pasków**: jeśli paski chrominancji gasną szybciej niż paski
 *   luminancji, tor kamery podpróbkowuje kolor (4:2:0) i moduły kolorowe
 *   muszą być odpowiednio większe.
 *
 * Wszystko w jednostkach modułów QR, więc wynik nie zależy od rozdzielczości.
 */

export const COLOR_TEST_MARKER = 'QRAIRGAP-COLORTEST';
export const COLOR_TEST_QR_VERSION = 10;
export const COLOR_TEST_MODULES = 17 + 4 * COLOR_TEST_QR_VERSION; // 57

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Point {
  x: number;
  y: number;
}

export type PatchKey = 'K' | 'R' | 'G' | 'B' | 'C' | 'M' | 'Y' | 'W';

export interface Patch {
  key: PatchKey;
  color: RGB;
  x: number;
  y: number;
  size: number;
}

export interface StripeBlock {
  kind: 'luma' | 'chroma';
  /** Szerokość jednego paska w modułach. */
  width: number;
  count: number;
  x: number;
  y: number;
  w: number;
  h: number;
  a: RGB;
  b: RGB;
}

export interface TestCard {
  modules: number;
  width: number;
  height: number;
  patches: Patch[];
  stripes: StripeBlock[];
}

export const PATCH_COLORS: Record<PatchKey, RGB> = {
  K: { r: 0, g: 0, b: 0 },
  R: { r: 255, g: 0, b: 0 },
  G: { r: 0, g: 255, b: 0 },
  B: { r: 0, g: 0, b: 255 },
  C: { r: 0, g: 255, b: 255 },
  M: { r: 255, g: 0, b: 255 },
  Y: { r: 255, g: 255, b: 0 },
  W: { r: 255, g: 255, b: 255 },
};

const BLACK = PATCH_COLORS.K;
const WHITE = PATCH_COLORS.W;
const BLUE = PATCH_COLORS.B;
/** Szary o luminancji Rec.601 równej czystemu niebieskiemu (0.114 · 255 ≈ 29). */
const BLUE_LUMA_GRAY: RGB = { r: 29, g: 29, b: 29 };

export function colorTestText(): string {
  return `${COLOR_TEST_MARKER} v1 N=${COLOR_TEST_MODULES}`;
}

export function parseColorTestModules(text: string): number | null {
  if (!text.startsWith(COLOR_TEST_MARKER)) return null;
  const m = /N=(\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

export function buildTestCard(modules = COLOR_TEST_MODULES): TestCard {
  const patchSize = 6;
  const gap = 1;
  const x0 = modules + 6;
  const patches: Patch[] = [];
  const rows: PatchKey[][] = [
    ['K', 'R', 'G', 'B'],
    ['C', 'M', 'Y', 'W'],
  ];
  rows.forEach((row, r) => {
    row.forEach((key, c) => {
      patches.push({
        key,
        color: PATCH_COLORS[key],
        x: x0 + c * (patchSize + gap),
        y: r * (patchSize + 2),
        size: patchSize,
      });
    });
  });

  const stripes: StripeBlock[] = [];
  const stripeCount = 4;
  const stripeHeight = 6;
  const kinds: { kind: 'luma' | 'chroma'; y: number; a: RGB; b: RGB }[] = [
    { kind: 'luma', y: 16, a: BLACK, b: WHITE },
    { kind: 'chroma', y: 24, a: BLUE_LUMA_GRAY, b: BLUE },
  ];
  let right = x0;
  for (const k of kinds) {
    let x = x0;
    for (let width = 1; width <= 4; width++) {
      const w = width * stripeCount;
      stripes.push({ kind: k.kind, width, count: stripeCount, x, y: k.y, w, h: stripeHeight, a: k.a, b: k.b });
      x += w + 2;
    }
    right = Math.max(right, x);
  }

  return { modules, width: right + 2, height: Math.max(modules, 32), patches, stripes };
}

// --- geometria ---------------------------------------------------------------

/** Rozwiązuje układ liniowy metodą Gaussa z wyborem elementu głównego. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const p = m[col][col];
    if (Math.abs(p) < 1e-12) throw new Error('Punkty są współliniowe');
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / p;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/** Homografia 3×3 (wierszami) odwzorowująca 4 punkty src na 4 punkty dst. */
export function homography(src: Point[], dst: Point[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [...h, 1];
}

export function applyHomography(h: number[], x: number, y: number): Point {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

/** Narożniki symbolu QR w pikselach obrazu: TL, TR, BR, BL (w orientacji symbolu). */
export type Corners = [Point, Point, Point, Point];

export function cardHomography(corners: Corners, modules: number): number[] {
  const src: Point[] = [
    { x: 0, y: 0 },
    { x: modules, y: 0 },
    { x: modules, y: modules },
    { x: 0, y: modules },
  ];
  return homography(src, corners);
}

// --- analiza -----------------------------------------------------------------

export interface ImageLike {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface PatchResult {
  key: PatchKey;
  nominal: RGB;
  measured: RGB;
  normalized: RGB;
}

export interface StripeResult {
  kind: 'luma' | 'chroma';
  width: number;
  contrast: number;
}

export interface ColorTestResult {
  patches: PatchResult[];
  /** Zapas na próg w każdym kanale (jednostki znormalizowane, 1 = idealnie). */
  margins: RGB;
  /** crosstalk[c][p]: znormalizowana odpowiedź kanału c (R,G,B) na czyste pole p (R,G,B). */
  crosstalk: number[][];
  stripes: StripeResult[];
  verdict: 'good' | 'marginal' | 'poor';
  summary: string;
}

function sampleAt(img: ImageLike, p: Point): RGB | null {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (x < 1 || y < 1 || x >= img.width - 1 || y >= img.height - 1) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const i = ((y + dy) * img.width + (x + dx)) * 4;
      r += img.data[i];
      g += img.data[i + 1];
      b += img.data[i + 2];
    }
  }
  return { r: r / 9, g: g / 9, b: b / 9 };
}

function meanRGB(samples: RGB[]): RGB {
  const n = Math.max(1, samples.length);
  return {
    r: samples.reduce((s, v) => s + v.r, 0) / n,
    g: samples.reduce((s, v) => s + v.g, 0) / n,
    b: samples.reduce((s, v) => s + v.b, 0) / n,
  };
}

function luma(c: RGB): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

function blueness(c: RGB): number {
  return c.b - c.r;
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function analyzeColorTest(img: ImageLike, corners: Corners, card: TestCard): ColorTestResult {
  const h = cardHomography(corners, card.modules);

  const patchMeasured = new Map<PatchKey, RGB>();
  for (const patch of card.patches) {
    const samples: RGB[] = [];
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        const mx = patch.x + patch.size * (0.2 + 0.15 * i);
        const my = patch.y + patch.size * (0.2 + 0.15 * j);
        const s = sampleAt(img, applyHomography(h, mx, my));
        if (s) samples.push(s);
      }
    }
    if (samples.length < 10) throw new Error(`Pole ${patch.key} poza kadrem`);
    patchMeasured.set(patch.key, meanRGB(samples));
  }

  const black = patchMeasured.get('K')!;
  const white = patchMeasured.get('W')!;
  const span = { r: white.r - black.r, g: white.g - black.g, b: white.b - black.b };
  if (span.r < 20 || span.g < 20 || span.b < 20) {
    throw new Error('Za mały kontrast między czernią a bielą (prześwietlenie lub niedoświetlenie)');
  }
  const normalize = (c: RGB): RGB => ({
    r: clamp01((c.r - black.r) / span.r),
    g: clamp01((c.g - black.g) / span.g),
    b: clamp01((c.b - black.b) / span.b),
  });

  const patches: PatchResult[] = card.patches.map((p) => {
    const measured = patchMeasured.get(p.key)!;
    return { key: p.key, nominal: p.color, measured, normalized: normalize(measured) };
  });

  const channels: (keyof RGB)[] = ['r', 'g', 'b'];
  const margins = { r: 0, g: 0, b: 0 };
  for (const ch of channels) {
    const on = patches.filter((p) => p.nominal[ch] === 255).map((p) => p.normalized[ch]);
    const off = patches.filter((p) => p.nominal[ch] === 0).map((p) => p.normalized[ch]);
    margins[ch] = Math.min(...on) - Math.max(...off);
  }

  const pure: PatchKey[] = ['R', 'G', 'B'];
  const crosstalk = channels.map((ch) =>
    pure.map((key) => patches.find((p) => p.key === key)!.normalized[ch]),
  );

  const lumaRef = luma(white) - luma(black);
  const blueRef = blueness(patchMeasured.get('B')!) - blueness(black);
  const stripes: StripeResult[] = card.stripes.map((block) => {
    const values: number[] = [];
    const cy = block.y + block.h / 2;
    for (let t = 0.5; t < block.w - 0.5; t += 0.1) {
      const s = sampleAt(img, applyHomography(h, block.x + t, cy));
      if (!s) continue;
      values.push(block.kind === 'luma' ? luma(s) : blueness(s));
    }
    const ref = block.kind === 'luma' ? lumaRef : blueRef;
    const contrast = values.length && ref > 1 ? clamp01((percentile(values, 0.9) - percentile(values, 0.1)) / ref) : 0;
    return { kind: block.kind, width: block.width, contrast };
  });

  const minMargin = Math.min(margins.r, margins.g, margins.b);
  const verdict: ColorTestResult['verdict'] = minMargin >= 0.35 ? 'good' : minMargin >= 0.15 ? 'marginal' : 'poor';

  const chroma2 = stripes.find((s) => s.kind === 'chroma' && s.width === 2)?.contrast ?? 0;
  const luma2 = stripes.find((s) => s.kind === 'luma' && s.width === 2)?.contrast ?? 0;
  const ratio = luma2 > 0.05 ? chroma2 / luma2 : 0;
  const parts = [
    `Najmniejszy margines separacji: ${minMargin.toFixed(2)} (${verdict === 'good' ? 'dobry' : verdict === 'marginal' ? 'graniczny' : 'za mały'}).`,
    `Paski 2-modułowe: chrominancja ${Math.round(chroma2 * 100)}% vs luminancja ${Math.round(luma2 * 100)}% kontrastu` +
      (ratio < 0.6 ? ' – kolor jest podpróbkowany, moduły kolorowe muszą być większe.' : ' – kolor niesie pełną rozdzielczość.'),
  ];

  return { patches, margins, crosstalk, stripes, verdict, summary: parts.join(' ') };
}

// --- renderer (nadajnik i testy) ----------------------------------------------

export interface Painter {
  fillRect(x: number, y: number, w: number, h: number, color: RGB): void;
}

/** Rysuje kartę (bez samego kodu QR) w jednostkach modułów; wywołujący dobiera skalę. */
export function paintTestCard(card: TestCard, paint: Painter): void {
  for (const p of card.patches) paint.fillRect(p.x, p.y, p.size, p.size, p.color);
  for (const s of card.stripes) {
    for (let i = 0; i < s.count; i++) {
      paint.fillRect(s.x + i * s.width, s.y, s.width, s.h, i % 2 === 0 ? s.a : s.b);
    }
  }
}
