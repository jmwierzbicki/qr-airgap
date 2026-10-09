/**
 * Abstrakcja nad dwoma silnikami skanowania:
 *  - `native`: BarcodeDetector API (Chrome na Androidzie/macOS/ChromeOS, Safari 17+),
 *    sprzętowo przyspieszane, najszybsze, zero pobierania;
 *  - `wasm`: zxing-wasm w Web Workerze (Windows/Linux Chrome, Firefox).
 *
 * Ramki niosą wyłącznie base64 (ASCII), bo BarcodeDetector zwraca tylko tekst
 * i przy surowych bajtach zgadywałby kodowanie znaków.
 */

import type { ScanWorkerRequest, ScanWorkerResult } from './scan.worker';

export type ScanEngine = 'native' | 'wasm';

interface DetectedBarcodeLike {
  rawValue: string;
  format: string;
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
  scan(video: HTMLVideoElement): Promise<string[]>;
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
  constructor(private readonly detector: BarcodeDetectorLike) {}

  async scan(video: HTMLVideoElement): Promise<string[]> {
    if (video.readyState < 2) return [];
    const found = await this.detector.detect(video);
    return found.map((b) => b.rawValue);
  }

  destroy(): void {}
}

class WasmScanner implements QrScanner {
  readonly engine: ScanEngine = 'wasm';
  private readonly worker: Worker;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private nextId = 1;
  private readonly waiting = new Map<number, (texts: string[]) => void>();

  private constructor(worker: Worker) {
    this.worker = worker;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.worker.addEventListener('message', (event: MessageEvent<ScanWorkerResult>) => {
      const msg = event.data;
      if (msg.type === 'result' && msg.id !== undefined) {
        const resolve = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        resolve?.(msg.texts ?? []);
      }
    });
  }

  static create(baseUrl: string): Promise<WasmScanner> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./scan.worker', import.meta.url), { type: 'module' });
      const onMessage = (event: MessageEvent<ScanWorkerResult>) => {
        if (event.data.type === 'ready') {
          worker.removeEventListener('message', onMessage);
          resolve(new WasmScanner(worker));
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

  scan(video: HTMLVideoElement): Promise<string[]> {
    if (video.readyState < 2 || !video.videoWidth) return Promise.resolve([]);
    const maxWidth = 1920;
    const ratio = Math.min(1, maxWidth / video.videoWidth);
    const width = Math.round(video.videoWidth * ratio);
    const height = Math.round(video.videoHeight * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ctx.drawImage(video, 0, 0, width, height);
    const image = this.ctx.getImageData(0, 0, width, height);
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      const request: ScanWorkerRequest = {
        type: 'frame',
        id,
        width,
        height,
        buffer: image.data.buffer as ArrayBuffer,
      };
      this.worker.postMessage(request, [request.buffer]);
    });
  }

  destroy(): void {
    this.worker.terminate();
    this.waiting.clear();
  }
}

export async function createQrScanner(baseUrl: string, prefer?: ScanEngine): Promise<QrScanner> {
  if (prefer !== 'wasm') {
    const detector = await nativeDetector();
    if (detector) return new NativeScanner(detector);
  }
  return WasmScanner.create(baseUrl);
}
