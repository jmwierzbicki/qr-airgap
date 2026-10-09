/**
 * Abstrakcja nad dwoma silnikami skanowania:
 *  - `native`: BarcodeDetector API (Chrome na Androidzie/macOS/ChromeOS, Safari 17+),
 *    sprzętowo przyspieszane, najszybsze, zero pobierania; zwraca tylko tekst,
 *    więc obsługuje wyłącznie ramki base64;
 *  - `wasm`: zxing-wasm w Web Workerze (Windows/Linux Chrome, Firefox); zwraca
 *    też surowe bajty, więc obsługuje ramki binarne.
 *
 * Tryb kolorowy (3 kody w kanałach R/G/B) działa w obu: klatka jest rozdzielana
 * na kanały i każdy dekodowany jako obraz w skali szarości.
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
  /** Rozdziela klatkę na kanały R, G, B i dekoduje każdy osobno. */
  scanColor(video: HTMLVideoElement): Promise<ScanHit[]>;
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

/** Wspólny bufor klatki: wideo → ImageData o ograniczonej szerokości. */
class FrameGrabber {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;

  constructor(private readonly maxWidth: number) {}

  grab(video: HTMLVideoElement): ImageData | null {
    if (video.readyState < 2 || !video.videoWidth) return null;
    const ratio = Math.min(1, this.maxWidth / video.videoWidth);
    const width = Math.round(video.videoWidth * ratio);
    const height = Math.round(video.videoHeight * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.drawImage(video, 0, 0, width, height);
    return this.ctx.getImageData(0, 0, width, height);
  }
}

function extractChannel(image: ImageData, channel: number): ImageData {
  const n = image.width * image.height;
  const out = new Uint8ClampedArray(n * 4);
  const src = image.data;
  for (let i = 0; i < n; i++) {
    const v = src[i * 4 + channel];
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, image.width, image.height);
}

class NativeScanner implements QrScanner {
  readonly engine: ScanEngine = 'native';
  readonly supportsBinary = false;
  private readonly grabber: FrameGrabber;

  constructor(
    private readonly detector: BarcodeDetectorLike,
    maxWidth: number,
  ) {
    this.grabber = new FrameGrabber(maxWidth);
  }

  async scan(video: HTMLVideoElement): Promise<ScanHit[]> {
    if (video.readyState < 2) return [];
    return this.toHits(await this.detector.detect(video));
  }

  async scanImage(image: ImageData): Promise<ScanHit[]> {
    return this.toHits(await this.detector.detect(image));
  }

  async scanColor(video: HTMLVideoElement): Promise<ScanHit[]> {
    const image = this.grabber.grab(video);
    if (!image) return [];
    const hits: ScanHit[] = [];
    for (let channel = 0; channel < 3; channel++) {
      const found = await this.detector.detect(extractChannel(image, channel));
      hits.push(...this.toHits(found).map((h) => ({ ...h, channel })));
    }
    return hits;
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
  private readonly grabber: FrameGrabber;
  private nextId = 1;
  private readonly waiting = new Map<number, (hits: ScanHit[]) => void>();

  private constructor(worker: Worker, maxWidth: number) {
    this.worker = worker;
    this.grabber = new FrameGrabber(maxWidth);
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
    const image = this.grabber.grab(video);
    if (!image) return Promise.resolve([]);
    return this.post('frame', image.width, image.height, image.data.buffer as ArrayBuffer);
  }

  scanImage(image: ImageData): Promise<ScanHit[]> {
    return this.post('frame', image.width, image.height, image.data.buffer.slice(0) as ArrayBuffer);
  }

  scanColor(video: HTMLVideoElement): Promise<ScanHit[]> {
    const image = this.grabber.grab(video);
    if (!image) return Promise.resolve([]);
    return this.post('colorFrame', image.width, image.height, image.data.buffer as ArrayBuffer);
  }

  private post(type: 'frame' | 'colorFrame', width: number, height: number, buffer: ArrayBuffer): Promise<ScanHit[]> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      const request: ScanWorkerRequest = { type, id, width, height, buffer };
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
  /** Maksymalna szerokość klatki przekazywanej do dekodera. */
  maxWidth?: number;
}

export async function createQrScanner(baseUrl: string, options: ScannerOptions = {}): Promise<QrScanner> {
  const maxWidth = options.maxWidth ?? 1920;
  if (options.prefer !== 'wasm') {
    const detector = await nativeDetector();
    if (detector) return new NativeScanner(detector, maxWidth);
  }
  return WasmScanner.create(baseUrl, maxWidth);
}
