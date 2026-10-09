import { utf8Decode } from './bytes';
import { FLAG_CALIBRATION } from './frame';
import {
  CALIBRATION_PROFILES,
  calibrationCodes,
  calibrationPayload,
  profileByName,
  profileIndex,
  profileName,
} from './profile';
import { decodeWire, encodeWire, looksLikeBinaryFrame } from './wire';

describe('profiles', () => {
  it('every calibration profile has a unique, resolvable name', () => {
    const names = new Set<string>();
    CALIBRATION_PROFILES.forEach((p, i) => {
      const name = profileName(p);
      expect(name).toBeTruthy();
      expect(names.has(name!)).toBe(false);
      names.add(name!);
      expect(profileByName(name!)).toEqual(p);
      expect(profileIndex(p)).toBe(i);
    });
    expect(names.size).toBe(72);
  });

  it('name lookup ignores case, spacing and diacritics', () => {
    const p = CALIBRATION_PROFILES[5];
    const name = profileName(p)!;
    expect(profileByName(`  ${name.toUpperCase()}  `)).toEqual(p);
    const ascii = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
    expect(profileByName(ascii)).toEqual(p);
    expect(profileByName('Nieistniejący Smok')).toBeNull();
    expect(profileName({ blockSize: 123, fps: 10, grid: 1, binary: false })).toBeNull();
  });

  it('calibration payload is deterministic and sized', () => {
    const a = calibrationPayload(3, 7, 400);
    const b = calibrationPayload(3, 7, 400);
    expect(a.length).toBe(400);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(calibrationPayload(3, 8, 400))).not.toEqual(Array.from(a));
    expect(calibrationCodes({ blockSize: 400, fps: 10, grid: 4, binary: true })).toBe(100);
  });
});

describe('wire', () => {
  const frame = {
    header: {
      fileId: 7,
      blockCount: 100,
      blockSize: 8,
      dataLength: 1,
      flags: FLAG_CALIBRATION,
      crc: 0,
      seed: 42,
    },
    payload: new Uint8Array([70, 81, 1, 2, 3, 4, 5, 6]),
  };

  it('round-trips in base64 and binary', () => {
    const b64 = encodeWire(frame, false);
    const text = utf8Decode(b64);
    expect(looksLikeBinaryFrame(text)).toBe(false);
    expect(decodeWire({ text })).toEqual(frame);
    expect(decodeWire({ text, bytes: b64 })).toEqual(frame);

    const bin = encodeWire(frame, true);
    expect(bin[0]).toBe(0x46);
    expect(decodeWire({ text: 'garbage', bytes: bin })).toEqual(frame);
    expect(looksLikeBinaryFrame(utf8Decode(bin))).toBe(true);
    expect(decodeWire({ text: utf8Decode(bin) })).toBeNull();
  });
});
