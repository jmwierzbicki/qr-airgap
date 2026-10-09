/**
 * Kontener: nazwa pliku + typ MIME + dane, opcjonalnie spakowany gzip (fflate).
 *
 *   0  u8   wersja
 *   1  u16  długość nazwy
 *   3  ...  nazwa (UTF-8)
 *      u16  długość MIME
 *      ...  MIME (UTF-8)
 *      ...  dane
 */

import { gunzipSync, gzipSync } from 'fflate';
import { utf8Decode, utf8Encode } from './bytes';
import { FLAG_GZIP } from './frame';

export const CONTAINER_VERSION = 1;
export { FLAG_GZIP };

export interface Payload {
  name: string;
  mime: string;
  data: Uint8Array;
}

export interface PackedContainer {
  bytes: Uint8Array;
  flags: number;
  rawLength: number;
}

export function packContainer(payload: Payload, compress = true): PackedContainer {
  const name = utf8Encode(payload.name).subarray(0, 0xffff);
  const mime = utf8Encode(payload.mime).subarray(0, 0xffff);
  const raw = new Uint8Array(1 + 2 + name.length + 2 + mime.length + payload.data.length);
  const view = new DataView(raw.buffer);
  let offset = 0;
  view.setUint8(offset, CONTAINER_VERSION);
  offset += 1;
  view.setUint16(offset, name.length);
  offset += 2;
  raw.set(name, offset);
  offset += name.length;
  view.setUint16(offset, mime.length);
  offset += 2;
  raw.set(mime, offset);
  offset += mime.length;
  raw.set(payload.data, offset);

  if (compress) {
    const packed = gzipSync(raw, { level: 6 });
    if (packed.length < raw.length * 0.98) {
      return { bytes: packed, flags: FLAG_GZIP, rawLength: raw.length };
    }
  }
  return { bytes: raw, flags: 0, rawLength: raw.length };
}

export function unpackContainer(bytes: Uint8Array, flags: number): Payload {
  const raw = flags & FLAG_GZIP ? gunzipSync(bytes) : bytes;
  if (raw.length < 5) throw new Error('Kontener jest za krótki');
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let offset = 0;
  const version = view.getUint8(offset);
  offset += 1;
  if (version !== CONTAINER_VERSION) throw new Error(`Nieznana wersja kontenera: ${version}`);
  const nameLen = view.getUint16(offset);
  offset += 2;
  const name = utf8Decode(raw.subarray(offset, offset + nameLen));
  offset += nameLen;
  const mimeLen = view.getUint16(offset);
  offset += 2;
  const mime = utf8Decode(raw.subarray(offset, offset + mimeLen));
  offset += mimeLen;
  return { name, mime, data: raw.subarray(offset) };
}
