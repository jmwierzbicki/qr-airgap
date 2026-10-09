/**
 * Transport dźwiękowy kanału zwrotnego oparty o ggwave (FSK + Reed-Solomon,
 * tryby słyszalne i ultradźwiękowe, 8–16 B/s). Biblioteka to jeden plik JS z
 * osadzonym WASM, ładowany z `ggwave/ggwave.js` (lokalnie, bez sieci).
 *
 * - `AudioFeedbackPlayer` (odbiornik): koduje bajty do fali i gra je głośnikiem.
 * - `AudioFeedbackListener` (nadajnik): słucha mikrofonu i oddaje zdekodowane bajty.
 *
 * Urządzenie odcięte od sieci (odbiornik) tylko gra; mikrofon włącza nadajnik.
 */

export type FeedbackProtocol = 'audible-fast' | 'audible-normal' | 'ultrasound-fast' | 'ultrasound-normal';

export const FEEDBACK_PROTOCOLS: { value: FeedbackProtocol; label: string }[] = [
  { value: 'audible-fast', label: 'słyszalny, szybki (zalecany)' },
  { value: 'audible-normal', label: 'słyszalny, odporny' },
  { value: 'ultrasound-fast', label: 'ultradźwięk, szybki' },
  { value: 'ultrasound-normal', label: 'ultradźwięk, odporny' },
];

interface GgwaveModule {
  getDefaultParameters(): GgwaveParameters;
  init(params: GgwaveParameters): number;
  free(instance: number): void;
  encode(instance: number, payload: Uint8Array | string, protocol: number, volume: number): Int8Array;
  decode(instance: number, samples: Int8Array): Uint8Array;
  disableLog(): void;
  ProtocolId: Record<string, number>;
  SampleFormat: Record<string, number>;
}

interface GgwaveParameters {
  payloadLength: number;
  sampleRateInp: number;
  sampleRateOut: number;
  sampleRate: number;
  samplesPerFrame: number;
  soundMarkerThreshold: number;
  sampleFormatInp: number;
  sampleFormatOut: number;
  operatingMode: number;
}

declare global {
  interface Window {
    ggwave_factory?: () => Promise<GgwaveModule>;
  }
}

let modulePromise: Promise<GgwaveModule> | null = null;

/** Ładuje ggwave.js przez <script> (CommonJS/Emscripten nie lubi bundlera) i inicjuje moduł. */
export function loadGgwave(baseUrl: string): Promise<GgwaveModule> {
  if (modulePromise) return modulePromise;
  modulePromise = new Promise<GgwaveModule>((resolve, reject) => {
    const finish = () => {
      const factory = window.ggwave_factory;
      if (!factory) {
        reject(new Error('ggwave_factory nie jest dostępne'));
        return;
      }
      factory()
        .then((m) => {
          try {
            m.disableLog();
          } catch {
            /* starsze buildy */
          }
          resolve(m);
        })
        .catch(reject);
    };
    if (window.ggwave_factory) {
      finish();
      return;
    }
    const script = document.createElement('script');
    script.src = new URL('ggwave/ggwave.js', baseUrl).href;
    script.async = true;
    script.onload = finish;
    script.onerror = () => reject(new Error('Nie udało się załadować ggwave.js'));
    document.head.appendChild(script);
  });
  modulePromise.catch(() => {
    modulePromise = null;
  });
  return modulePromise;
}

function protocolId(m: GgwaveModule, p: FeedbackProtocol): number {
  const map: Record<FeedbackProtocol, string> = {
    'audible-fast': 'GGWAVE_PROTOCOL_AUDIBLE_FAST',
    'audible-normal': 'GGWAVE_PROTOCOL_AUDIBLE_NORMAL',
    'ultrasound-fast': 'GGWAVE_PROTOCOL_ULTRASOUND_FAST',
    'ultrasound-normal': 'GGWAVE_PROTOCOL_ULTRASOUND_NORMAL',
  };
  return m.ProtocolId[map[p]];
}

function createInstance(m: GgwaveModule, sampleRate: number): number {
  const params = m.getDefaultParameters();
  params.sampleRateInp = sampleRate;
  params.sampleRateOut = sampleRate;
  params.sampleFormatInp = m.SampleFormat['GGWAVE_SAMPLE_FORMAT_F32'];
  params.sampleFormatOut = m.SampleFormat['GGWAVE_SAMPLE_FORMAT_F32'];
  return m.init(params);
}

/** Odbiornik: gra raporty głośnikiem. */
export class AudioFeedbackPlayer {
  private readonly ctx: AudioContext;
  private readonly instance: number;
  private playingUntil = 0;

  private constructor(
    private readonly m: GgwaveModule,
    ctx: AudioContext,
  ) {
    this.ctx = ctx;
    this.instance = createInstance(m, ctx.sampleRate);
  }

  static async create(baseUrl: string): Promise<AudioFeedbackPlayer> {
    const m = await loadGgwave(baseUrl);
    const ctx = new AudioContext();
    await ctx.resume();
    return new AudioFeedbackPlayer(m, ctx);
  }

  get busy(): boolean {
    return this.ctx.currentTime < this.playingUntil;
  }

  /** Zwraca czas trwania nadanego sygnału w sekundach. */
  play(payload: Uint8Array, protocol: FeedbackProtocol, volume = 50): number {
    const raw = this.m.encode(this.instance, payload, protocolId(this.m, protocol), volume);
    const samples = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const buffer = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime, this.playingUntil);
    source.start(startAt);
    this.playingUntil = startAt + buffer.duration;
    return buffer.duration;
  }

  destroy(): void {
    try {
      this.m.free(this.instance);
    } catch {
      /* ignoruj */
    }
    void this.ctx.close();
  }
}

/** Nadajnik: słucha mikrofonu i dekoduje raporty. */
export class AudioFeedbackListener {
  private readonly instance: number;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  private constructor(
    private readonly m: GgwaveModule,
    private readonly ctx: AudioContext,
    private readonly stream: MediaStream,
    private readonly onMessage: (bytes: Uint8Array) => void,
  ) {
    this.instance = createInstance(m, ctx.sampleRate);
  }

  static async create(baseUrl: string, onMessage: (bytes: Uint8Array) => void): Promise<AudioFeedbackListener> {
    const m = await loadGgwave(baseUrl);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    const ctx = new AudioContext();
    await ctx.resume();
    const listener = new AudioFeedbackListener(m, ctx, stream, onMessage);
    listener.start();
    return listener;
  }

  private start(): void {
    this.source = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessorNode jest przestarzały, ale działa wszędzie i nie wymaga osobnego pliku workletu.
    this.processor = this.ctx.createScriptProcessor(1024, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const bytes = new Int8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
      const out = this.m.decode(this.instance, bytes);
      if (out && out.length) this.onMessage(new Uint8Array(out));
    };
    this.source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
  }

  destroy(): void {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    try {
      this.m.free(this.instance);
    } catch {
      /* ignoruj */
    }
    void this.ctx.close();
  }
}
