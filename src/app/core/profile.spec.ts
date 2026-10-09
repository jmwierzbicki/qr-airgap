import { utf8Decode } from './bytes';
import { FLAG_CALIBRATION } from './frame';
import {
  CALIBRATION_BW_COUNT,
  CALIBRATION_PROFILES,
  calibrationCodes,
  calibrationPayload,
  calibrationRange,
  codesPerFrame,
  profileByName,
  profileIndex,
  profileName,
} from './profile';
import { decodeWire, diagnoseWire, encodeWire, looksLikeBinaryFrame } from './wire';

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
    expect(CALIBRATION_BW_COUNT).toBe(36);
    expect(names.size).toBe(60);
    expect(calibrationRange('bw')).toEqual([0, 36]);
    expect(calibrationRange('color')).toEqual([36, 60]);
    expect(CALIBRATION_PROFILES.slice(0, 36).every((p) => !p.color)).toBe(true);
    expect(CALIBRATION_PROFILES.slice(36).every((p) => p.color)).toBe(true);
  });

  it('name lookup ignores case, spacing and diacritics', () => {
    const p = CALIBRATION_PROFILES[5];
    const name = profileName(p)!;
    expect(profileByName(`  ${name.toUpperCase()}  `)).toEqual(p);
    const ascii = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
    expect(profileByName(ascii)).toEqual(p);
    expect(profileByName('Nieistniejący Smok')).toBeNull();
    expect(profileName({ blockSize: 123, fps: 10, grid: 1, binary: true, color: false })).toBeNull();
    expect(profileName({ blockSize: 700, fps: 10, grid: 1, binary: false, color: false })).toBeNull();
    expect(profileName({ blockSize: 700, fps: 10, grid: 4, binary: true, color: true })).toBeNull();
  });

  it('calibration payload is deterministic and code counts include colour channels', () => {
    const a = calibrationPayload(3, 7, 400);
    const b = calibrationPayload(3, 7, 400);
    expect(a.length).toBe(400);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(calibrationPayload(3, 8, 400))).not.toEqual(Array.from(a));
    const bw = { blockSize: 400, fps: 10, grid: 4 as const, binary: true, color: false };
    const color = { ...bw, grid: 2 as const, color: true };
    expect(codesPerFrame(bw)).toBe(4);
    expect(codesPerFrame(color)).toBe(6);
    expect(calibrationCodes(bw)).toBe(80);
    expect(calibrationCodes(color)).toBe(120);
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

  it('diagnoses why a hit cannot be decoded', () => {
    const bin = encodeWire(frame, true);
    expect(diagnoseWire({ text: 'https://example.com' })).toBe('not-ours');
    expect(diagnoseWire({ text: '' })).toBe('binary-as-text');
    expect(diagnoseWire({ text: utf8Decode(bin) })).toBe('binary-as-text');
    const old = encodeWire(frame, true);
    old[2] = 1;
    expect(diagnoseWire({ text: 'x', bytes: old })).toBe('version');
    expect(diagnoseWire({ text: utf8Decode(encodeWire({ ...frame }, false)).replace(/^RlE/, 'RlEB') })).toBe('not-ours');
  });
});
