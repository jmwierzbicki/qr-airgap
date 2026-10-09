/**
 * Warstwa "na drucie": jak ramka trafia do kodu QR i jak wraca ze skanera.
 *
 * - base64: ramka jako tekst ASCII w trybie bajtowym QR. Działa z każdym
 *   skanerem (BarcodeDetector zwraca tylko tekst), kosztuje 25% pojemności.
 * - binary: surowe bajty ramki w trybie bajtowym QR. Wymaga skanera, który
 *   oddaje bajty (zxing-wasm); +33% danych w tym samym kodzie.
 */

import { base64ToBytes, bytesToBase64, utf8Encode } from './bytes';
import { FRAME_VERSION, decodeFrame, encodeFrame, type Frame } from './frame';

export interface ScanHit {
  text: string;
  bytes?: Uint8Array;
  /** Narożniki symbolu w pikselach obrazu: TL, TR, BR, BL (orientacja symbolu). */
  corners?: { x: number; y: number }[];
  /** Kanał koloru, z którego pochodzi odczyt (0 = R, 1 = G, 2 = B); brak = skala szarości. */
  channel?: number;
}

export function encodeWire(frame: Frame, binary: boolean): Uint8Array {
  const raw = encodeFrame(frame);
  return binary ? raw : utf8Encode(bytesToBase64(raw));
}

/** Surowa ramka zaczyna się od ASCII "FQ"; base64 takiej ramki zaczyna się od "RlE". */
export function looksLikeBinaryFrame(text: string): boolean {
  return text.length > 2 && text.charCodeAt(0) === 0x46 && text.charCodeAt(1) === 0x51;
}

export type WireProblem = 'not-ours' | 'binary-as-text' | 'version';

/**
 * Dlaczego odczytu nie da się zdekodować: obcy kod, ramka binarna odczytana
 * przez skaner tekstowy (BarcodeDetector) albo inna wersja formatu.
 */
export function diagnoseWire(hit: ScanHit): WireProblem {
  const candidates: Uint8Array[] = [];
  if (hit.bytes && hit.bytes.length > 2) candidates.push(hit.bytes);
  const fromText = base64ToBytes(hit.text.trim());
  if (fromText) candidates.push(fromText);
  for (const bytes of candidates) {
    if (bytes.length > 3 && bytes[0] === 0x46 && bytes[1] === 0x51 && bytes[2] !== FRAME_VERSION) return 'version';
  }
  if (!hit.bytes && (hit.text === '' || looksLikeBinaryFrame(hit.text))) return 'binary-as-text';
  return 'not-ours';
}

export function decodeWire(hit: ScanHit): Frame | null {
  if (hit.bytes && hit.bytes.length > 2 && hit.bytes[0] === 0x46 && hit.bytes[1] === 0x51) {
    const frame = decodeFrame(hit.bytes);
    if (frame) return frame;
  }
  const bytes = base64ToBytes(hit.text.trim());
  return bytes ? decodeFrame(bytes) : null;
}
