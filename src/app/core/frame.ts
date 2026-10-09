/**
 * Format pojedynczej ramki (jeden kod QR = jedna ramka).
 *
 * Każda ramka jest samowystarczalna: niesie pełny nagłówek transferu, więc
 * odbiornik może dołączyć w dowolnym momencie i nie potrzebuje żadnego kanału
 * zwrotnego. Układ (big-endian):
 *
 *   0  u16  magic 'FQ'
 *   2  u8   wersja formatu
 *   3  u32  fileId      losowy identyfikator transferu
 *   7  u32  blockCount  K, liczba bloków źródłowych
 *  11  u16  blockSize   rozmiar bloku w bajtach
 *  13  u32  dataLength  długość kontenera (po ewentualnej kompresji)
 *  17  u8   flags       bit0 = gzip, bit1 = ramka kalibracyjna, bit2 = kod w kanale koloru
 *  18  u32  crc32       suma kontrolna kontenera
 *  22  u32  seed        numer kropli (seed generatora sąsiadów)
 *  26  ...  payload     blockSize bajtów (XOR wybranych bloków)
 *
 * Ramka kalibracyjna (bit1): fileId = indeks profilu w tabeli, blockCount =
 * liczba kodów wysyłanych w tym profilu, dataLength = wersja tabeli, crc = 0,
 * seed = numer kodu w profilu, payload = pseudolosowe bajty.
 */

export const FRAME_MAGIC = 0x4651;
export const FRAME_VERSION = 1;
export const HEADER_SIZE = 26;
export const FLAG_GZIP = 0b01;
export const FLAG_CALIBRATION = 0b10;
/** Ramka pochodzi z transmisji kolorowej (3 kody w kanałach R, G, B jednej komórki). */
export const FLAG_COLOR = 0b100;

export interface FrameHeader {
  fileId: number;
  blockCount: number;
  blockSize: number;
  dataLength: number;
  flags: number;
  crc: number;
  seed: number;
}

export interface Frame {
  header: FrameHeader;
  payload: Uint8Array;
}

export function encodeFrame(frame: Frame): Uint8Array {
  const { header, payload } = frame;
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, FRAME_MAGIC);
  view.setUint8(2, FRAME_VERSION);
  view.setUint32(3, header.fileId >>> 0);
  view.setUint32(7, header.blockCount >>> 0);
  view.setUint16(11, header.blockSize);
  view.setUint32(13, header.dataLength >>> 0);
  view.setUint8(17, header.flags & 0xff);
  view.setUint32(18, header.crc >>> 0);
  view.setUint32(22, header.seed >>> 0);
  out.set(payload, HEADER_SIZE);
  return out;
}

export function decodeFrame(bytes: Uint8Array): Frame | null {
  if (bytes.length < HEADER_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== FRAME_MAGIC) return null;
  if (view.getUint8(2) !== FRAME_VERSION) return null;
  const header: FrameHeader = {
    fileId: view.getUint32(3),
    blockCount: view.getUint32(7),
    blockSize: view.getUint16(11),
    dataLength: view.getUint32(13),
    flags: view.getUint8(17),
    crc: view.getUint32(18),
    seed: view.getUint32(22),
  };
  if (header.blockCount === 0 || header.blockSize === 0) return null;
  const payload = bytes.subarray(HEADER_SIZE);
  if (payload.length !== header.blockSize) return null;
  return { header, payload };
}

/** Czy dwa nagłówki opisują ten sam transfer. */
export function sameTransfer(a: FrameHeader, b: FrameHeader): boolean {
  return (
    a.fileId === b.fileId &&
    a.blockCount === b.blockCount &&
    a.blockSize === b.blockSize &&
    a.dataLength === b.dataLength &&
    a.crc === b.crc
  );
}
