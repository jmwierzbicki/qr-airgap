import { mulberry32 } from './bytes';
import {
  FEEDBACK_STALE_MS,
  FeedbackPlanner,
  adjustFps,
  decodeFeedback,
  encodeFeedback,
  hintedSeed,
  seedHint,
  type FeedbackMessage,
} from './feedback';
import { LtDecoder, LtEncoder, LtScheme } from './lt';

function randomBytes(length: number, seed = 1): Uint8Array {
  const rand = mulberry32(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

describe('feedback message', () => {
  it('round-trips with and without a missing list', () => {
    const msg: FeedbackMessage = {
      transferId: 0xbeef,
      decoded: 123,
      blockCount: 250,
      recentCodes: 31,
      complete: false,
      missing: [5, 77, 200_000],
    };
    const bytes = encodeFeedback(msg);
    expect(bytes.length).toBe(15 + 12);
    expect(decodeFeedback(bytes)).toEqual(msg);
    const done = encodeFeedback({ ...msg, decoded: 250, complete: true, missing: [] });
    expect(done.length).toBe(15);
    expect(decodeFeedback(done)?.complete).toBe(true);
    expect(decodeFeedback(bytes.subarray(0, 10))).toBeNull();
    expect(decodeFeedback(new Uint8Array(20))).toBeNull();
  });

  it('hinted seeds keep the counter and the hint apart', () => {
    const seed = hintedSeed(13, 4242);
    expect(seedHint(seed)).toBe(13);
    expect(seed & 0xffffff).toBe(4242);
    expect(seedHint(hintedSeed(999, 1))).toBe(255);
    expect(seedHint(5)).toBe(0);
  });
});

describe('LtScheme with degree hints', () => {
  it('uses degree K/hint for hinted seeds and robust soliton otherwise', () => {
    const scheme = new LtScheme(200);
    expect(scheme.neighbors(hintedSeed(10, 300)).length).toBe(20);
    expect(scheme.neighbors(hintedSeed(1, 300)).length).toBe(200);
    expect(scheme.neighbors(hintedSeed(255, 300)).length).toBe(1);
    const n = scheme.neighbors(hintedSeed(10, 300));
    expect(new Set(n).size).toBe(n.length);
    expect(new LtScheme(200).neighbors(hintedSeed(10, 300))).toEqual(n);
  });

  it('fills gaps far faster with a correct hint than blind', () => {
    const K = 250;
    const blockSize = 100;
    const data = randomBytes(K * blockSize, 9);
    const enc = new LtEncoder(data, blockSize);
    const loss = mulberry32(5);

    const run = (hinted: boolean) => {
      const dec = new LtDecoder(K, blockSize);
      for (let seed = 0; seed < K; seed++) if (loss() >= 0.05) dec.addDroplet(seed, enc.droplet(seed));
      let counter = K;
      let sent = 0;
      while (!dec.isComplete && sent < 5000) {
        const missing = K - dec.decodedCount;
        const seed = hinted ? hintedSeed(missing, counter++) : counter++;
        dec.addDroplet(seed, enc.droplet(seed));
        sent++;
      }
      expect(dec.isComplete).toBe(true);
      return sent;
    };
    const blind = run(false);
    const smart = run(true);
    expect(smart * 2).toBeLessThan(blind);
  });
});

describe('FeedbackPlanner', () => {
  const K = 20;
  const id = 7;

  it('behaves like a plain sender without reports', () => {
    const p = new FeedbackPlanner(K, id);
    const seeds = Array.from({ length: K + 3 }, () => p.next(0));
    expect(seeds.slice(0, K)).toEqual(Array.from({ length: K }, (_, i) => i));
    expect(seeds.slice(K)).toEqual([K, K + 1, K + 2]);
    expect(p.complete).toBe(false);
  });

  it('ignores reports of other transfers and stops on completion', () => {
    const p = new FeedbackPlanner(K, id);
    expect(p.report({ transferId: 99, decoded: 20, blockCount: K, recentCodes: 1, complete: true, missing: [] }, 0)).toBe(false);
    expect(p.complete).toBe(false);
    expect(p.report({ transferId: id, decoded: 20, blockCount: K, recentCodes: 1, complete: true, missing: [] }, 0)).toBe(true);
    expect(p.complete).toBe(true);
  });

  it('after the systematic pass alternates missing blocks with hinted droplets', () => {
    const p = new FeedbackPlanner(K, id);
    for (let i = 0; i < K; i++) p.next(0);
    p.report({ transferId: id, decoded: 17, blockCount: K, recentCodes: 10, complete: false, missing: [3, 9, 15] }, 1000);
    const seeds = Array.from({ length: 6 }, () => p.next(1100));
    const direct = seeds.filter((s) => s < K);
    const hinted = seeds.filter((s) => s >= K);
    expect(direct).toEqual([3, 9, 15]);
    expect(hinted.every((s) => seedHint(s) === 3)).toBe(true);
    expect(new Set(hinted).size).toBe(hinted.length);
  });

  it('falls back to blind droplets when the report is stale', () => {
    const p = new FeedbackPlanner(K, id);
    for (let i = 0; i < K; i++) p.next(0);
    p.report({ transferId: id, decoded: 10, blockCount: K, recentCodes: 10, complete: false, missing: [] }, 0);
    expect(seedHint(p.next(10))).toBe(10);
    expect(seedHint(p.next(FEEDBACK_STALE_MS + 1))).toBe(0);
  });

  it('restarts the systematic pass for a late receiver, once per stale window', () => {
    const p = new FeedbackPlanner(K, id);
    for (let i = 0; i < K + 5; i++) p.next(0);
    p.report({ transferId: id, decoded: 0, blockCount: K, recentCodes: 0, complete: false, missing: [] }, 1000);
    expect(p.next(1000)).toBe(0);
    expect(p.next(1000)).toBe(1);
    for (let i = 2; i < K; i++) p.next(1000);
    p.report({ transferId: id, decoded: 0, blockCount: K, recentCodes: 0, complete: false, missing: [] }, 2000);
    expect(p.next(2000)).toBeGreaterThanOrEqual(K);
  });
});

describe('adjustFps', () => {
  it('steps up when nearly everything arrives and down when little does', () => {
    expect(adjustFps(10, 24, 25)).toBe(11);
    expect(adjustFps(20, 25, 25)).toBe(20);
    expect(adjustFps(10, 10, 25)).toBe(8);
    expect(adjustFps(3, 0, 25)).toBe(3);
    expect(adjustFps(10, 17, 25)).toBe(10);
    expect(adjustFps(10, 5, 0)).toBe(10);
  });
});
