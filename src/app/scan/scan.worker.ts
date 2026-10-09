/// <reference lib="webworker" />
/**
 * Web Worker dekodujący kody QR przez zxing-wasm (ZXing-C++ skompilowany do
 * WebAssembly). Plik .wasm jest serwowany lokalnie z katalogu `zxing/`, więc
 * aplikacja działa bez dostępu do sieci.
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

export interface ScanWorkerResult {
  type: 'ready' | 'result' | 'error';
  id?: number;
  texts?: string[];
  message?: string;
}

const readerOptions: ReaderOptions = {
  formats: ['QRCode'],
  tryHarder: true,
  tryRotate: false,
  tryInvert: false,
  tryDownscale: true,
  maxNumberOfSymbols: 1,
  textMode: 'Plain',
};

let ready: Promise<unknown> | null = null;

function reply(message: ScanWorkerResult): void {
  postMessage(message);
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
      reply({
        type: 'result',
        id: request.id,
        texts: results.filter((r) => r.isValid).map((r) => r.text),
      });
    } catch (err) {
      reply({ type: 'result', id: request.id, texts: [], message: String(err) });
    }
  }
});
