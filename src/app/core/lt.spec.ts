import { base64ToBytes, bytesToBase64, crc32, mulberry32, utf8Encode } from './bytes';
import { packContainer, unpackContainer } from './container';
import { decodeFrame, encodeFrame, HEADER_SIZE } from './frame';
import { LtDecoder, LtEncoder, LtScheme, robustSolitonCdf } from './lt';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function randomBytes(length: number, seed = 1): Uint8Array {
  const rand = mulberry32(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

describe('bytes', () => {
  it('crc32 matches the reference vector', () => {
    expect(crc32(utf8Encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('base64 round-trips binary data', () => {
    const data = randomBytes(70000, 7);
    expect(base64ToBytes(bytesToBase64(data))).toEqual(data);
    expect(base64ToBytes('not base64 !!')).toBeNull();
  });

  it('mulberry32 is deterministic', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });
});

describe('robust soliton', () => {
  it('produces a valid cdf for various K', () => {
    for (const K of [1, 2, 3, 10, 100, 1000, 5000]) {
      const cdf = robustSolitonCdf(K);
      expect(cdf.length).toBe(K);
      expect(cdf[K - 1]).toBe(1);
      for (let i = 1; i < K; i++) {
        expect(cdf[i]).toBeGreaterThanOrEqual(cdf[i - 1]);
      }
      expect(cdf[0]).toBeGreaterThan(0);
    }
  });

  it('neighbors are deterministic, distinct and systematic for seed < K', () => {
    const scheme = new LtScheme(50);
    for (let seed = 0; seed < 50; seed++) expect(scheme.neighbors(seed)).toEqual([seed]);
    for (let seed = 50; seed < 500; seed++) {
      const n = scheme.neighbors(seed);
      expect(n.length).toBeGreaterThanOrEqual(1);
      expect(n.length).toBeLessThanOrEqual(50);
      expect(new Set(n).size).toBe(n.length);
      expect(new LtScheme(50).neighbors(seed)).toEqual(n);
    }
  });
});

describe('LT codec', () => {
  it('decodes losslessly from the systematic pass alone', () => {
    const data = randomBytes(10_000, 3);
    const enc = new LtEncoder(data, 100);
    const dec = new LtDecoder(enc.blockCount, 100);
    for (let seed = 0; seed < enc.blockCount; seed++) {
      dec.addDroplet(seed, enc.droplet(seed));
    }
    expect(dec.isComplete).toBe(true);
    expect(bytesEqual(dec.assemble(data.length), data)).toBe(true);
    expect(dec.stats.droplets).toBe(enc.blockCount);
  });

  it('recovers with 35% random frame loss and a late start', () => {
    const data = randomBytes(60_000, 11);
    const blockSize = 300;
    const enc = new LtEncoder(data, blockSize);
    const dec = new LtDecoder(enc.blockCount, blockSize);
    const loss = mulberry32(99);
    let seed = 73;
    let received = 0;
    while (!dec.isComplete && seed < 100_000) {
      if (loss() >= 0.35) {
        dec.addDroplet(seed, enc.droplet(seed));
        received++;
      }
      seed++;
    }
    expect(dec.isComplete).toBe(true);
    expect(bytesEqual(dec.assemble(data.length), data)).toBe(true);
    expect(received).toBeLessThan(enc.blockCount * 1.6);
  });

  it('handles a single block and tiny payloads', () => {
    const data = utf8Encode('hej');
    const enc = new LtEncoder(data, 600);
    expect(enc.blockCount).toBe(1);
    const dec = new LtDecoder(1, 600);
    expect(dec.addDroplet(5, enc.droplet(5))).toBe(true);
    expect(bytesEqual(dec.assemble(data.length), data)).toBe(true);
  });

  it('counts duplicates and redundant droplets', () => {
    const data = randomBytes(1000, 5);
    const enc = new LtEncoder(data, 100);
    const dec = new LtDecoder(enc.blockCount, 100);
    expect(dec.addDroplet(0, enc.droplet(0))).toBe(true);
    expect(dec.addDroplet(0, enc.droplet(0))).toBe(false);
    expect(dec.stats.duplicates).toBe(1);
  });
});

describe('frame + container', () => {
  it('frame round-trips and rejects garbage', () => {
    const payload = randomBytes(200, 8);
    const header = {
      fileId: 0xdeadbeef,
      blockCount: 1234,
      blockSize: 200,
      dataLength: 246_000,
      flags: 1,
      crc: 0x12345678,
      seed: 999_999,
    };
    const bytes = encodeFrame({ header, payload });
    expect(bytes.length).toBe(HEADER_SIZE + 200);
    const frame = decodeFrame(bytes);
    expect(frame?.header).toEqual(header);
    expect(bytesEqual(frame!.payload, payload)).toBe(true);
    expect(decodeFrame(randomBytes(300, 1))).toBeNull();
    expect(decodeFrame(bytes.subarray(0, 100))).toBeNull();
  });

  it('container round-trips with and without compression', () => {
    const text = utf8Encode('Lorem ipsum '.repeat(500));
    const packed = packContainer({ name: 'zażółć.txt', mime: 'text/plain', data: text });
    expect(packed.flags & 1).toBe(1);
    expect(packed.bytes.length).toBeLessThan(text.length);
    const out = unpackContainer(packed.bytes, packed.flags);
    expect(out.name).toBe('zażółć.txt');
    expect(out.mime).toBe('text/plain');
    expect(bytesEqual(out.data, text)).toBe(true);

    const noisy = randomBytes(5000, 2);
    const raw = packContainer({ name: 'a.bin', mime: 'application/octet-stream', data: noisy });
    expect(raw.flags).toBe(0);
    expect(bytesEqual(unpackContainer(raw.bytes, raw.flags).data, noisy)).toBe(true);
  });

  it('end to end: pack, encode, decode, unpack', () => {
    const original = randomBytes(20_000, 21);
    const packed = packContainer({ name: 'x.bin', mime: 'application/octet-stream', data: original });
    const blockSize = 500;
    const enc = new LtEncoder(packed.bytes, blockSize);
    const dec = new LtDecoder(enc.blockCount, blockSize);
    const header = {
      fileId: 1,
      blockCount: enc.blockCount,
      blockSize,
      dataLength: packed.bytes.length,
      flags: packed.flags,
      crc: crc32(packed.bytes),
      seed: 0,
    };
    let seed = 10;
    while (!dec.isComplete) {
      const wire = bytesToBase64(encodeFrame({ header: { ...header, seed }, payload: enc.droplet(seed) }));
      const frame = decodeFrame(base64ToBytes(wire)!)!;
      dec.addDroplet(frame.header.seed, frame.payload);
      seed += 3;
    }
    const data = dec.assemble(header.dataLength);
    expect(crc32(data)).toBe(header.crc);
    expect(bytesEqual(unpackContainer(data, header.flags).data, original)).toBe(true);
  });
});
