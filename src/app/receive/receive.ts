import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  signal,
  viewChild,
} from '@angular/core';
import { base64ToBytes, crc32, formatBytes, utf8Decode } from '../core/bytes';
import { unpackContainer } from '../core/container';
import { decodeFrame, sameTransfer, type FrameHeader } from '../core/frame';
import { LtDecoder } from '../core/lt';
import { createQrScanner, type QrScanner, type ScanEngine } from '../scan/qr-scanner';

interface ScanStats {
  frames: number;
  codes: number;
  useful: number;
  duplicates: number;
  invalid: number;
}

interface ReceivedFile {
  name: string;
  mime: string;
  size: number;
  url: string;
  text: string | null;
}

const TEXT_EXTENSIONS = /\.(txt|md|lua|json|js|ts|py|csv|xml|html|css|yml|yaml|ini|cfg|log|sh|bat)$/i;

@Component({
  selector: 'app-receive',
  imports: [DecimalPipe],
  templateUrl: './receive.html',
  styleUrl: './receive.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Receive implements OnInit, OnDestroy {
  readonly formatBytes = formatBytes;

  readonly cameras = signal<MediaDeviceInfo[]>([]);
  readonly selectedCamera = signal('');
  readonly running = signal(false);
  readonly starting = signal(false);
  readonly engine = signal<ScanEngine | ''>('');
  readonly preferredEngine = signal<ScanEngine | 'auto'>('auto');
  readonly error = signal('');
  readonly stats = signal<ScanStats>({ frames: 0, codes: 0, useful: 0, duplicates: 0, invalid: 0 });
  readonly transfer = signal<FrameHeader | null>(null);
  readonly decoded = signal(0);
  readonly elapsed = signal(0);
  readonly result = signal<ReceivedFile | null>(null);
  readonly lastCodeAt = signal(0);

  readonly progress = computed(() => {
    const t = this.transfer();
    return t ? (this.decoded() / t.blockCount) * 100 : 0;
  });
  readonly scanRate = computed(() => (this.elapsed() > 0 ? this.stats().frames / this.elapsed() : 0));
  readonly codeRate = computed(() => (this.elapsed() > 0 ? this.stats().codes / this.elapsed() : 0));
  readonly etaSeconds = computed(() => {
    const t = this.transfer();
    const rate = this.stats().useful / Math.max(this.elapsed(), 0.001);
    if (!t || !rate) return null;
    return Math.max(0, (t.blockCount - this.decoded()) / rate);
  });

  private readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly gridRef = viewChild<ElementRef<HTMLCanvasElement>>('grid');

  private scanner: QrScanner | null = null;
  private stream: MediaStream | null = null;
  private decoder: LtDecoder | null = null;
  private startedAt = 0;
  private clock: ReturnType<typeof setInterval> | null = null;
  private gridDirty = false;
  private loopToken = 0;

  async ngOnInit(): Promise<void> {
    await this.refreshCameras();
  }

  ngOnDestroy(): void {
    this.stop();
    this.revokeResult();
  }

  onCamera(event: Event): void {
    this.selectedCamera.set((event.target as HTMLSelectElement).value);
    if (this.running()) void this.start();
  }

  onEngine(event: Event): void {
    this.preferredEngine.set((event.target as HTMLSelectElement).value as ScanEngine | 'auto');
    if (this.running()) void this.start();
  }

  async start(): Promise<void> {
    this.stop();
    this.error.set('');
    this.starting.set(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Przeglądarka nie udostępnia kamery (wymagane HTTPS lub localhost).');
      }
      const deviceId = this.selectedCamera();
      const video: MediaTrackConstraints = deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } };
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      const el = this.videoRef()?.nativeElement;
      if (!el) throw new Error('Brak elementu wideo');
      el.srcObject = this.stream;
      await el.play();
      await this.refreshCameras();

      const prefer = this.preferredEngine();
      this.scanner = await createQrScanner(document.baseURI, prefer === 'auto' ? undefined : prefer);
      this.engine.set(this.scanner.engine);

      this.running.set(true);
      this.startClock();
      void this.loop(++this.loopToken, el);
    } catch (err) {
      this.error.set(this.describeError(err));
      this.stop();
    } finally {
      this.starting.set(false);
    }
  }

  stop(): void {
    this.loopToken++;
    this.running.set(false);
    this.scanner?.destroy();
    this.scanner = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const el = this.videoRef()?.nativeElement;
    if (el) el.srcObject = null;
    if (this.clock) {
      clearInterval(this.clock);
      this.clock = null;
    }
  }

  reset(): void {
    this.decoder = null;
    this.transfer.set(null);
    this.decoded.set(0);
    this.revokeResult();
    this.stats.set({ frames: 0, codes: 0, useful: 0, duplicates: 0, invalid: 0 });
    this.startedAt = performance.now();
    this.elapsed.set(0);
    this.drawGrid();
  }

  async copyText(): Promise<void> {
    const text = this.result()?.text;
    if (text) await navigator.clipboard.writeText(text);
  }

  private async loop(token: number, video: HTMLVideoElement): Promise<void> {
    while (token === this.loopToken && this.scanner) {
      let texts: string[] = [];
      try {
        texts = await this.scanner.scan(video);
      } catch (err) {
        this.error.set(this.describeError(err));
      }
      if (token !== this.loopToken) return;
      this.stats.update((s) => ({ ...s, frames: s.frames + 1 }));
      for (const text of texts) this.handleText(text);
      // setTimeout zamiast requestAnimationFrame: rAF zamiera w karcie w tle i przy ukrytym oknie.
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  private handleText(text: string): void {
    const bytes = base64ToBytes(text);
    const frame = bytes && decodeFrame(bytes);
    if (!frame) {
      this.stats.update((s) => ({ ...s, invalid: s.invalid + 1 }));
      return;
    }
    const current = this.transfer();
    if (!current || !this.decoder || !sameTransfer(current, frame.header)) {
      this.beginTransfer(frame.header);
    }
    this.stats.update((s) => ({ ...s, codes: s.codes + 1 }));
    this.lastCodeAt.set(performance.now());
    const decoder = this.decoder!;
    if (decoder.isComplete) return;

    const useful = decoder.addDroplet(frame.header.seed, frame.payload);
    this.stats.update((s) =>
      useful ? { ...s, useful: s.useful + 1 } : { ...s, duplicates: s.duplicates + 1 },
    );
    if (useful) {
      this.decoded.set(decoder.decodedCount);
      this.scheduleGrid();
      if (decoder.isComplete) this.finish(frame.header, decoder);
    }
  }

  private beginTransfer(header: FrameHeader): void {
    this.revokeResult();
    this.decoder = new LtDecoder(header.blockCount, header.blockSize);
    this.transfer.set({ ...header, seed: 0 });
    this.decoded.set(0);
    this.stats.set({ frames: 0, codes: 0, useful: 0, duplicates: 0, invalid: 0 });
    this.startedAt = performance.now();
    this.elapsed.set(0);
    this.scheduleGrid();
  }

  private finish(header: FrameHeader, decoder: LtDecoder): void {
    try {
      const data = decoder.assemble(header.dataLength);
      const crc = crc32(data);
      if (crc !== header.crc) {
        throw new Error(
          `Suma kontrolna się nie zgadza (oczekiwano ${header.crc.toString(16)}, jest ${crc.toString(16)}).`,
        );
      }
      const payload = unpackContainer(data, header.flags);
      const blob = new Blob([payload.data as BlobPart], {
        type: payload.mime || 'application/octet-stream',
      });
      const isText =
        payload.mime.startsWith('text/') ||
        payload.mime === 'application/json' ||
        TEXT_EXTENSIONS.test(payload.name);
      this.result.set({
        name: payload.name,
        mime: payload.mime,
        size: payload.data.length,
        url: URL.createObjectURL(blob),
        text: isText && payload.data.length <= 512 * 1024 ? utf8Decode(payload.data) : null,
      });
      this.error.set('');
    } catch (err) {
      this.error.set(`Odbiór nieudany: ${this.describeError(err)}. Wciśnij "Wyczyść" i spróbuj ponownie.`);
    }
  }

  private revokeResult(): void {
    const r = this.result();
    if (r) URL.revokeObjectURL(r.url);
    this.result.set(null);
  }

  private startClock(): void {
    if (this.clock) clearInterval(this.clock);
    this.startedAt = performance.now();
    this.clock = setInterval(() => {
      this.elapsed.set((performance.now() - this.startedAt) / 1000);
    }, 250);
  }

  private scheduleGrid(): void {
    if (this.gridDirty) return;
    this.gridDirty = true;
    setTimeout(() => {
      this.gridDirty = false;
      this.drawGrid();
    }, 50);
  }

  private drawGrid(): void {
    const canvas = this.gridRef()?.nativeElement;
    if (!canvas) return;
    const width = canvas.clientWidth || 600;
    const decoder = this.decoder;
    if (!decoder) {
      canvas.width = width;
      canvas.height = 8;
      return;
    }
    const K = decoder.blockCount;
    const cols = Math.min(K, Math.max(1, Math.floor(width / 6)));
    const cell = Math.max(2, Math.floor(width / cols));
    const rows = Math.ceil(K / cols);
    canvas.width = cols * cell;
    canvas.height = rows * cell;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#16a34a';
    const mask = decoder.decodedMask();
    for (let i = 0; i < K; i++) {
      if (!mask[i]) continue;
      const x = (i % cols) * cell;
      const y = Math.floor(i / cols) * cell;
      ctx.fillRect(x, y, cell - 1, cell - 1);
    }
  }

  private async refreshCameras(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.cameras.set(devices.filter((d) => d.kind === 'videoinput'));
    } catch {
      this.cameras.set([]);
    }
  }

  private describeError(err: unknown): string {
    if (err instanceof DOMException) {
      if (err.name === 'NotAllowedError') return 'Brak zgody na użycie kamery.';
      if (err.name === 'NotFoundError') return 'Nie znaleziono kamery.';
      if (err.name === 'NotReadableError') return 'Kamera jest zajęta przez inną aplikację.';
      return `${err.name}: ${err.message}`;
    }
    return err instanceof Error ? err.message : String(err);
  }
}
