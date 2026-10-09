/**
 * Kanał zwrotny (odbiornik → nadajnik), np. przez dźwięk (ggwave).
 *
 * Odbiornik co kilka sekund wysyła krótki raport: ile bloków ma, ile kodów
 * odebrał ostatnio, czy skończył, i (gdy brakuje niewiele) listę brakujących
 * indeksów. Nadajnik na tej podstawie:
 *  - zatrzymuje się, gdy odbiornik ma komplet (auto-stop);
 *  - dosyła wprost brakujące bloki z listy;
 *  - dobiera stopień kropli do liczby braków (K/m), co kilkukrotnie skraca
 *    łatanie dziur w porównaniu z rozkładem "na ślepo";
 *  - powtarza cykl systematyczny, gdy odbiornik zgłasza zero (dołączył późno);
 *  - opcjonalnie reguluje fps.
 *
 * Stopień kropli jest zakodowany w górnych 8 bitach numeru kropli (patrz
 * LtScheme), więc odbiornik nie musi nic wiedzieć o kanale zwrotnym.
 *
 * Układ raportu (big-endian):
 *   0  u8   magic 'Q'
 *   1  u8   wersja
 *   2  u16  transferId (dolne 16 bitów fileId)
 *   4  u32  decoded
 *   8  u32  blockCount
 *  12  u8   recentCodes (kodów odebranych w ostatnim oknie, max 255)
 *  13  u8   flags: bit0 = komplet
 *  14  u8   n = liczba indeksów brakujących bloków (0..MAX_MISSING)
 *  15  u32 × n
 */

export const FEEDBACK_MAGIC = 0x51;
export const FEEDBACK_VERSION = 1;
export const FEEDBACK_MAX_MISSING = 4;
/** Jak często odbiornik wysyła raport i w jakim oknie liczy odebrane kody. */
export const FEEDBACK_INTERVAL_MS = 2500;
/** Po jakim czasie bez raportu nadajnik wraca do nadawania "na ślepo". */
export const FEEDBACK_STALE_MS = 8000;
/** Największa podpowiedź stopnia mieszcząca się w 8 bitach numeru kropli. */
export const HINT_MAX = 255;
export const HINT_SHIFT = 24;
export const COUNTER_MASK = (1 << HINT_SHIFT) - 1;

export interface FeedbackMessage {
  transferId: number;
  decoded: number;
  blockCount: number;
  recentCodes: number;
  complete: boolean;
  missing: number[];
}

export function transferIdOf(fileId: number): number {
  return fileId & 0xffff;
}

export function encodeFeedback(msg: FeedbackMessage): Uint8Array {
  const missing = msg.missing.slice(0, FEEDBACK_MAX_MISSING);
  const out = new Uint8Array(15 + 4 * missing.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, FEEDBACK_MAGIC);
  view.setUint8(1, FEEDBACK_VERSION);
  view.setUint16(2, msg.transferId & 0xffff);
  view.setUint32(4, msg.decoded >>> 0);
  view.setUint32(8, msg.blockCount >>> 0);
  view.setUint8(12, Math.min(255, Math.max(0, Math.round(msg.recentCodes))));
  view.setUint8(13, msg.complete ? 1 : 0);
  view.setUint8(14, missing.length);
  missing.forEach((idx, i) => view.setUint32(15 + 4 * i, idx >>> 0));
  return out;
}

export function decodeFeedback(bytes: Uint8Array): FeedbackMessage | null {
  if (bytes.length < 15) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== FEEDBACK_MAGIC || view.getUint8(1) !== FEEDBACK_VERSION) return null;
  const n = view.getUint8(14);
  if (n > FEEDBACK_MAX_MISSING || bytes.length < 15 + 4 * n) return null;
  const missing: number[] = [];
  for (let i = 0; i < n; i++) missing.push(view.getUint32(15 + 4 * i));
  return {
    transferId: view.getUint16(2),
    decoded: view.getUint32(4),
    blockCount: view.getUint32(8),
    recentCodes: view.getUint8(12),
    complete: (view.getUint8(13) & 1) === 1,
    missing,
  };
}

/** Numer kropli z podpowiedzią stopnia: górne 8 bitów = spodziewana liczba braków. */
export function hintedSeed(hint: number, counter: number): number {
  const h = Math.max(0, Math.min(HINT_MAX, Math.round(hint)));
  return ((h << HINT_SHIFT) | (counter & COUNTER_MASK)) >>> 0;
}

export function seedHint(seed: number): number {
  return seed >>> HINT_SHIFT;
}

export interface PlannerState {
  /** Ostatni raport (lub null). */
  report: FeedbackMessage | null;
  reportAt: number;
  /** Czy transfer jest według odbiornika kompletny. */
  complete: boolean;
}

/**
 * Nadajnikowy planer numerów kropli. Bez raportów zachowuje się jak zwykły
 * nadajnik (cykl systematyczny, potem robust soliton). Z raportami dosyła to,
 * czego brakuje.
 */
export class FeedbackPlanner {
  private systematic = 0;
  private counter: number;
  private state: PlannerState = { report: null, reportAt: 0, complete: false };
  private missingCursor = 0;
  private alternate = false;
  private lastRestartAt = -Infinity;

  constructor(
    readonly blockCount: number,
    readonly transferId: number,
  ) {
    this.counter = blockCount;
  }

  get lastReport(): PlannerState {
    return this.state;
  }

  /** Przyjmuje raport; raporty innego transferu są ignorowane. */
  report(msg: FeedbackMessage, now: number): boolean {
    if (msg.transferId !== this.transferId) return false;
    this.state = { report: msg, reportAt: now, complete: msg.complete || msg.decoded >= this.blockCount };
    this.missingCursor = 0;
    return true;
  }

  isFresh(now: number): boolean {
    return this.state.report !== null && now - this.state.reportAt < FEEDBACK_STALE_MS;
  }

  get complete(): boolean {
    return this.state.complete;
  }

  /** Kolejny numer kropli do nadania. */
  next(now: number): number {
    const K = this.blockCount;
    const fresh = this.isFresh(now);
    const report = this.state.report;

    // Spóźniony odbiornik: zgłasza zero po zakończonym cyklu systematycznym → cykl od nowa.
    if (fresh && report && report.decoded === 0 && this.systematic >= K && now - this.lastRestartAt > FEEDBACK_STALE_MS) {
      this.systematic = 0;
      this.lastRestartAt = now;
    }

    if (this.systematic < K) return this.systematic++;

    if (fresh && report) {
      const missing = Math.max(1, K - report.decoded);
      this.alternate = !this.alternate;
      if (report.missing.length && this.alternate) {
        const idx = report.missing[this.missingCursor % report.missing.length];
        this.missingCursor++;
        return idx;
      }
      return hintedSeed(missing, this.counter++);
    }
    return this.counter++;
  }
}

/** Prosta regulacja fps na podstawie stosunku kodów odebranych do nadanych w oknie raportu. */
export function adjustFps(current: number, received: number, sent: number, min = 3, max = 20): number {
  if (sent <= 0) return current;
  const ratio = received / sent;
  if (ratio >= 0.85 && current < max) return current + 1;
  if (ratio < 0.5 && current > min) return Math.max(min, current - 2);
  return current;
}
