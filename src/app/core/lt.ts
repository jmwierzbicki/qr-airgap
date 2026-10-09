/**
 * Kod fontannowy Luby Transform (LT) z rozkładem robust soliton.
 *
 * Dlaczego fontanna, a nie kolejne numerowane kawałki: kanał kamera-ekran jest
 * jednokierunkowy i gubi ramki (rozmycie, autofokus, refresh ekranu). Przy
 * sekwencyjnym nadawaniu odbiornik musi czekać na powtórkę brakującej ramki,
 * a przy kilku procentach strat to oznacza wiele pełnych cykli. Kod LT emituje
 * nieskończony strumień "kropli" (XOR losowego podzbioru bloków); wystarczy
 * odebrać ok. K * 1.05-1.15 dowolnych kropli, żeby odzyskać K bloków.
 *
 * Dodatkowo pierwsze K kropli jest systematycznych (kropla i = blok i), więc
 * przy bezstratnym odbiorze pierwszy cykl wystarcza w 100%, a fontanna tylko
 * "łata dziury".
 */

import { mulberry32, xorInto } from './bytes';

/**
 * Dystrybuanta rozkładu robust soliton dla K bloków.
 * cdf[i-1] = P(stopień <= i). Parametry c i delta wg Luby (2002); c=0.1,
 * delta=0.5 to typowe wartości dające mały narzut przy K rzędu setek-tysięcy.
 */
export function robustSolitonCdf(blockCount: number, c = 0.1, delta = 0.5): Float64Array {
  const K = blockCount;
  if (K <= 1) return Float64Array.of(1);

  const R = c * Math.log(K / delta) * Math.sqrt(K);
  const spike = Math.max(1, Math.min(K, Math.floor(K / R)));
  const weights = new Float64Array(K + 1);
  let total = 0;

  for (let d = 1; d <= K; d++) {
    const rho = d === 1 ? 1 / K : 1 / (d * (d - 1));
    let tau = 0;
    if (d < spike) tau = R / (d * K);
    else if (d === spike) tau = (R * Math.log(R / delta)) / K;
    if (!(tau > 0) || !Number.isFinite(tau)) tau = 0;
    weights[d] = rho + tau;
    total += weights[d];
  }

  const cdf = new Float64Array(K);
  let acc = 0;
  for (let d = 1; d <= K; d++) {
    acc += weights[d] / total;
    cdf[d - 1] = acc;
  }
  cdf[K - 1] = 1;
  return cdf;
}

function sampleDegree(cdf: Float64Array, u: number): number {
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cdf[mid] >= u) hi = mid;
    else lo = mid + 1;
  }
  return lo + 1;
}

/**
 * Wspólna dla nadajnika i odbiornika reguła: z numeru kropli (seed) i K
 * deterministycznie wyznacza listę bloków wchodzących w skład kropli.
 */
export class LtScheme {
  private readonly cdf: Float64Array;

  constructor(readonly blockCount: number) {
    if (!Number.isInteger(blockCount) || blockCount < 1) {
      throw new Error(`Nieprawidłowa liczba bloków: ${blockCount}`);
    }
    this.cdf = robustSolitonCdf(blockCount);
  }

  neighbors(seed: number): number[] {
    const K = this.blockCount;
    if (seed < K) return [seed];

    const rand = mulberry32(seed);
    const degree = sampleDegree(this.cdf, rand());

    if (degree * 2 <= K) {
      const picked = new Set<number>();
      while (picked.size < degree) {
        picked.add(Math.floor(rand() * K));
      }
      return [...picked];
    }

    const perm = new Array<number>(K);
    for (let i = 0; i < K; i++) perm[i] = i;
    for (let i = 0; i < degree; i++) {
      const j = i + Math.floor(rand() * (K - i));
      const tmp = perm[i];
      perm[i] = perm[j];
      perm[j] = tmp;
    }
    return perm.slice(0, degree);
  }
}

export class LtEncoder {
  readonly blockCount: number;
  readonly scheme: LtScheme;
  private readonly padded: Uint8Array;

  constructor(
    data: Uint8Array,
    readonly blockSize: number,
  ) {
    if (blockSize < 1 || blockSize > 0xffff) {
      throw new Error(`Nieprawidłowy rozmiar bloku: ${blockSize}`);
    }
    this.blockCount = Math.max(1, Math.ceil(data.length / blockSize));
    this.padded = new Uint8Array(this.blockCount * blockSize);
    this.padded.set(data);
    this.scheme = new LtScheme(this.blockCount);
  }

  droplet(seed: number): Uint8Array {
    const out = new Uint8Array(this.blockSize);
    for (const block of this.scheme.neighbors(seed)) {
      const offset = block * this.blockSize;
      for (let i = 0; i < this.blockSize; i++) {
        out[i] ^= this.padded[offset + i];
      }
    }
    return out;
  }
}

interface PendingDroplet {
  remaining: Set<number>;
  data: Uint8Array;
}

export interface DecoderStats {
  droplets: number;
  duplicates: number;
  redundant: number;
}

/**
 * Dekoder "peeling" (belief propagation): kropla o jednym nierozwiązanym
 * sąsiedzie od razu ujawnia blok, a ujawniony blok jest wyXORowywany ze
 * wszystkich oczekujących kropli, co kaskadowo uwalnia kolejne.
 */
export class LtDecoder {
  readonly blocks: (Uint8Array | null)[];
  readonly scheme: LtScheme;
  readonly stats: DecoderStats = { droplets: 0, duplicates: 0, redundant: 0 };
  decodedCount = 0;

  private readonly seen = new Set<number>();
  private readonly pending = new Set<PendingDroplet>();
  private readonly byBlock = new Map<number, Set<PendingDroplet>>();

  constructor(
    readonly blockCount: number,
    readonly blockSize: number,
  ) {
    this.scheme = new LtScheme(blockCount);
    this.blocks = new Array(blockCount).fill(null);
  }

  get isComplete(): boolean {
    return this.decodedCount === this.blockCount;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Zwraca true, jeśli kropla wniosła nową informację. */
  addDroplet(seed: number, payload: Uint8Array): boolean {
    if (this.seen.has(seed)) {
      this.stats.duplicates++;
      return false;
    }
    this.seen.add(seed);
    this.stats.droplets++;
    if (this.isComplete) {
      this.stats.redundant++;
      return false;
    }

    const data = payload.slice(0, this.blockSize);
    const remaining = new Set(this.scheme.neighbors(seed));
    for (const block of remaining) {
      const known = this.blocks[block];
      if (known) {
        xorInto(data, known);
        remaining.delete(block);
      }
    }

    if (remaining.size === 0) {
      this.stats.redundant++;
      return false;
    }
    if (remaining.size === 1) {
      this.resolve(remaining.values().next().value as number, data);
      return true;
    }

    const droplet: PendingDroplet = { remaining, data };
    this.pending.add(droplet);
    for (const block of remaining) {
      let set = this.byBlock.get(block);
      if (!set) {
        set = new Set();
        this.byBlock.set(block, set);
      }
      set.add(droplet);
    }
    return true;
  }

  private resolve(firstBlock: number, firstData: Uint8Array): void {
    const queue: [number, Uint8Array][] = [[firstBlock, firstData]];
    while (queue.length) {
      const [block, data] = queue.pop()!;
      if (this.blocks[block]) continue;
      this.blocks[block] = data;
      this.decodedCount++;

      const waiting = this.byBlock.get(block);
      if (!waiting) continue;
      this.byBlock.delete(block);
      for (const droplet of waiting) {
        xorInto(droplet.data, data);
        droplet.remaining.delete(block);
        if (droplet.remaining.size === 1) {
          this.pending.delete(droplet);
          const only = droplet.remaining.values().next().value as number;
          this.byBlock.get(only)?.delete(droplet);
          queue.push([only, droplet.data]);
        }
      }
    }
  }

  assemble(dataLength: number): Uint8Array {
    if (!this.isComplete) throw new Error('Dekodowanie nie jest ukończone');
    const out = new Uint8Array(this.blockCount * this.blockSize);
    for (let i = 0; i < this.blockCount; i++) {
      out.set(this.blocks[i]!, i * this.blockSize);
    }
    return out.subarray(0, dataLength);
  }

  decodedMask(): Uint8Array {
    const mask = new Uint8Array(this.blockCount);
    for (let i = 0; i < this.blockCount; i++) {
      if (this.blocks[i]) mask[i] = 1;
    }
    return mask;
  }
}
