/// <reference lib="webworker" />
/**
 * Web Worker dekodujący kody QR przez zxing-wasm (ZXing-C++ skompilowany do
 * WebAssembly). Plik .wasm jest serwowany lokalnie z katalogu `zxing/`, więc
 * aplikacja działa bez dostępu do sieci. Zwraca tekst, surowe bajty i narożniki
 * symbolu; dekoduje do 8 kodów na klatkę. W trybie kolorowym rozdziela klatkę na
 * kanały R, G, B i dekoduje każdy osobno jako obraz w skali szarości.
 */

import { prepareZXingModule, readBarcodes, type ReaderOptions } from 'zxing-wasm/reader';

export interface ScanWorkerInit {
  type: 'init';
  baseUrl: string;
}

export interface ScanWorkerFrame {
  type: 'frame' | 'colorFrame';
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
  /** Kanał, z którego pochodzi odczyt w trybie kolorowym (0 = R, 1 = G, 2 = B). */
  channel?: number;
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
let channelBuffer: Uint8ClampedArray<ArrayBuffer> | null = null;

function reply(message: ScanWorkerResult, transfer: Transferable[] = []): void {
  postMessage(message, transfer);
}

async function decode(image: ImageData, channel?: number): Promise<ScanWorkerHit[]> {
  const results = await readBarcodes(image, readerOptions);
  return results
    .filter((r) => r.isValid)
    .map((r) => ({
      text: r.text,
      bytes: r.bytes.slice(),
      corners: [r.position.topLeft, r.position.topRight, r.position.bottomRight, r.position.bottomLeft].map(
        (p) => ({ x: p.x, y: p.y }),
      ),
      channel,
    }));
}

/** Kanał c obrazu RGBA jako obraz w skali szarości (r = g = b = kanał). */
function extractChannel(src: Uint8ClampedArray, width: number, height: number, channel: number): ImageData {
  const n = width * height;
  if (!channelBuffer || channelBuffer.length !== n * 4) channelBuffer = new Uint8ClampedArray(n * 4);
  const out = channelBuffer;
  for (let i = 0; i < n; i++) {
    const v = src[i * 4 + channel];
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, width, height);
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

  try {
    await ready;
    const pixels = new Uint8ClampedArray(request.buffer);
    let hits: ScanWorkerHit[] = [];
    if (request.type === 'frame') {
      hits = await decode(new ImageData(pixels, request.width, request.height));
    } else {
      for (let channel = 0; channel < 3; channel++) {
        const image = extractChannel(pixels, request.width, request.height, channel);
        hits.push(...(await decode(image, channel)));
      }
    }
    reply(
      { type: 'result', id: request.id, hits },
      hits.map((h) => h.bytes.buffer as ArrayBuffer),
    );
  } catch (err) {
    reply({ type: 'result', id: request.id, hits: [], message: String(err) });
  }
});
