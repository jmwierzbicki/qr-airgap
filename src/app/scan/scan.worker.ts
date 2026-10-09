/// <reference lib="webworker" />
/**
 * Web Worker dekodujący kody QR przez zxing-wasm (ZXing-C++ skompilowany do
 * WebAssembly). Plik .wasm jest serwowany lokalnie z katalogu `zxing/`, więc
 * aplikacja działa bez dostępu do sieci. Zwraca tekst i surowe bajty, więc
 * obsługuje zarówno ramki base64, jak i binarne; dekoduje do 8 kodów na klatkę.
 */

import { prepareZXingModule, readBarcodes, type ReaderOptions } from 'zxing-wasm/reader';

export interface ScanWorkerInit {
  type: 'init';
  baseUrl: string;
}

export interface ScanWorkerFrame {
  type: 'frame';
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

export type ScanWorkerRequest = ScanWorkerInit | ScanWorkerFrame;

export interface ScanWorkerHit {
  text: string;
  bytes: Uint8Array;
  corners: { x: number; y: number }[];
}

export interface ScanWorkerResult {
  type: 'ready' | 'result' | 'error';
  id?: number;
  hits?: ScanWorkerHit[];
  message?: string;
}

const readerOptions: ReaderOptions = {
  formats: ['QRCode'],
  tryHarder: true,
  tryRotate: false,
  tryInvert: false,
  tryDownscale: true,
  maxNumberOfSymbols: 8,
  textMode: 'Plain',
};

let ready: Promise<unknown> | null = null;

function reply(message: ScanWorkerResult, transfer: Transferable[] = []): void {
  postMessage(message, transfer);
}

addEventListener('message', async (event: MessageEvent<ScanWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'init') {
    ready = prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) =>
          path.endsWith('.wasm') ? new URL(`zxing/${path}`, request.baseUrl).href : prefix + path,
      },
      fireImmediately: true,
    });
    try {
      await ready;
      reply({ type: 'ready' });
    } catch (err) {
      reply({ type: 'error', message: String(err) });
    }
    return;
  }

  if (request.type === 'frame') {
    try {
      await ready;
      const image = new ImageData(new Uint8ClampedArray(request.buffer), request.width, request.height);
      const results = await readBarcodes(image, readerOptions);
      const hits: ScanWorkerHit[] = results
        .filter((r) => r.isValid)
        .map((r) => ({
          text: r.text,
          bytes: r.bytes.slice(),
          corners: [r.position.topLeft, r.position.topRight, r.position.bottomRight, r.position.bottomLeft].map(
            (p) => ({ x: p.x, y: p.y }),
          ),
        }));
      reply(
        { type: 'result', id: request.id, hits },
        hits.map((h) => h.bytes.buffer as ArrayBuffer),
      );
    } catch (err) {
      reply({ type: 'result', id: request.id, hits: [], message: String(err) });
    }
  }
});
