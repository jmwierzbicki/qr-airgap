/**
 * Abstrakcja nad dwoma silnikami skanowania:
 *  - `native`: BarcodeDetector API (Chrome na Androidzie/macOS/ChromeOS, Safari 17+),
 *    sprzętowo przyspieszane, najszybsze, zero pobierania; zwraca tylko tekst,
 *    więc obsługuje wyłącznie ramki base64;
 *  - `wasm`: zxing-wasm w Web Workerze (Windows/Linux Chrome, Firefox); zwraca
 *    też surowe bajty, więc obsługuje ramki binarne.
 */

import type { ScanHit } from '../core/wire';
import type { ScanWorkerRequest, ScanWorkerResult } from './scan.worker';

export type ScanEngine = 'native' | 'wasm';

interface DetectedBarcodeLike {
  rawValue: string;
  format: string;
  cornerPoints?: { x: number; y: number }[];
}

interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement | HTMLCanvasElement | ImageData): Promise<DetectedBarcodeLike[]>;
}

interface BarcodeDetectorCtor {
  new (options?: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

export interface QrScanner {
  readonly engine: ScanEngine;
  readonly supportsBinary: boolean;
  scan(video: HTMLVideoElement): Promise<ScanHit[]>;
  /** Dekoduje gotową klatkę (obraz zostaje u wywołującego, np. do analizy kolorów). */
  scanImage(image: ImageData): Promise<ScanHit[]>;
  destroy(): void;
}

async function nativeDetector(): Promise<BarcodeDetectorLike | null> {
  const ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!ctor) return null;
  try {
    const formats = await ctor.getSupportedFormats();
    if (!formats.includes('qr_code')) return null;
    return new ctor({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

class NativeScanner implements QrScanner {
  readonly engine: ScanEngine = 'native';
  readonly supportsBinary = false;
  constructor(private readonly detector: BarcodeDetectorLike) {}

  async scan(video: HTMLVideoElement): Promise<ScanHit[]> {
    if (video.readyState < 2) return [];
    return this.toHits(await this.detector.detect(video));
  }

  async scanImage(image: ImageData): Promise<ScanHit[]> {
    return this.toHits(await this.detector.detect(image));
  }

  private toHits(found: DetectedBarcodeLike[]): ScanHit[] {
    return found.map((b) => ({
      text: b.rawValue,
      corners: b.cornerPoints?.length === 4 ? b.cornerPoints.map((p) => ({ x: p.x, y: p.y })) : undefined,
    }));
  }

  destroy(): void {}
}

class WasmScanner implements QrScanner {
  readonly engine: ScanEngine = 'wasm';
  readonly supportsBinary = true;
  private readonly worker: Worker;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private nextId = 1;
  private readonly waiting = new Map<number, (hits: ScanHit[]) => void>();

  private constructor(
    worker: Worker,
    private readonly maxWidth: number,
  ) {
    this.worker = worker;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.worker.addEventListener('message', (event: MessageEvent<ScanWorkerResult>) => {
      const msg = event.data;
      if (msg.type === 'result' && msg.id !== undefined) {
        const resolve = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        resolve?.(msg.hits ?? []);
      }
    });
  }

  static create(baseUrl: string, maxWidth: number): Promise<WasmScanner> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./scan.worker', import.meta.url), { type: 'module' });
      const onMessage = (event: MessageEvent<ScanWorkerResult>) => {
        if (event.data.type === 'ready') {
          worker.removeEventListener('message', onMessage);
          resolve(new WasmScanner(worker, maxWidth));
        } else if (event.data.type === 'error') {
          worker.removeEventListener('message', onMessage);
          worker.terminate();
          reject(new Error(event.data.message ?? 'Nie udało się załadować zxing-wasm'));
        }
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', (e) => reject(new Error(e.message)), { once: true });
      const init: ScanWorkerRequest = { type: 'init', baseUrl };
      worker.postMessage(init);
    });
  }

  scan(video: HTMLVideoElement): Promise<ScanHit[]> {
    if (video.readyState < 2 || !video.videoWidth) return Promise.resolve([]);
    const ratio = Math.min(1, this.maxWidth / video.videoWidth);
    const width = Math.round(video.videoWidth * ratio);
    const height = Math.round(video.videoHeight * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.drawImage(video, 0, 0, width, height);
    const image = this.ctx.getImageData(0, 0, width, height);
    return this.post(image.width, image.height, image.data.buffer as ArrayBuffer);
  }

  scanImage(image: ImageData): Promise<ScanHit[]> {
    return this.post(image.width, image.height, image.data.buffer.slice(0) as ArrayBuffer);
  }

  private post(width: number, height: number, buffer: ArrayBuffer): Promise<ScanHit[]> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      const request: ScanWorkerRequest = { type: 'frame', id, width, height, buffer };
      this.worker.postMessage(request, [buffer]);
    });
  }

  destroy(): void {
    this.worker.terminate();
    this.waiting.clear();
  }
}

export interface ScannerOptions {
  prefer?: ScanEngine;
  /** Maksymalna szerokość klatki przekazywanej do dekodera wasm. */
  maxWidth?: number;
}

export async function createQrScanner(baseUrl: string, options: ScannerOptions = {}): Promise<QrScanner> {
  if (options.prefer !== 'wasm') {
    const detector = await nativeDetector();
    if (detector) return new NativeScanner(detector);
  }
  return WasmScanner.create(baseUrl, options.maxWidth ?? 1920);
}
