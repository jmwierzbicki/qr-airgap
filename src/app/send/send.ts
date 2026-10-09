import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  signal,
  viewChild,
} from '@angular/core';
import QRCode from 'qrcode';
import { bytesToBase64, crc32, formatBytes, randomUint32, utf8Encode } from '../core/bytes';
import { packContainer, type PackedContainer } from '../core/container';
import { encodeFrame, HEADER_SIZE, type FrameHeader } from '../core/frame';
import { LtEncoder } from '../core/lt';

interface PreparedPayload {
  name: string;
  mime: string;
  size: number;
  packed: PackedContainer;
}

type EcLevel = 'L' | 'M' | 'Q';

/** Presety rozmiaru bloku: im większy, tym gęstszy kod i trudniejszy odczyt. */
export const BLOCK_PRESETS = [
  { value: 200, label: '200 B (telefon z daleka, słabe światło)' },
  { value: 400, label: '400 B (bezpieczny)' },
  { value: 600, label: '600 B (zalecany)' },
  { value: 900, label: '900 B (dobra kamera)' },
  { value: 1300, label: '1300 B (monitor + nowoczesny telefon)' },
  { value: 2000, label: '2000 B (maksimum, wymaga ostrego obrazu)' },
];

@Component({
  selector: 'app-send',
  imports: [DecimalPipe],
  templateUrl: './send.html',
  styleUrl: './send.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Send implements OnDestroy {
  readonly blockPresets = BLOCK_PRESETS;
  readonly formatBytes = formatBytes;

  readonly text = signal('');
  readonly payload = signal<PreparedPayload | null>(null);
  readonly blockSize = signal(600);
  readonly fps = signal(8);
  readonly ecLevel = signal<EcLevel>('L');
  readonly running = signal(false);
  readonly framesSent = signal(0);
  readonly qrVersion = signal(0);
  readonly qrModules = signal(0);
  readonly error = signal('');

  /** Dla małych wiadomości blok kurczy się do rozmiaru danych, żeby kod QR był jak najrzadszy. */
  readonly effectiveBlockSize = computed(() => {
    const p = this.payload();
    const size = this.blockSize();
    return p ? Math.max(1, Math.min(size, p.packed.bytes.length)) : size;
  });
  readonly blockCount = computed(() => {
    const p = this.payload();
    return p ? Math.max(1, Math.ceil(p.packed.bytes.length / this.effectiveBlockSize())) : 0;
  });
  readonly frameBytes = computed(() => HEADER_SIZE + this.effectiveBlockSize());
  readonly cycleSeconds = computed(() => this.blockCount() / this.fps());
  readonly cycleProgress = computed(() => {
    const k = this.blockCount();
    return k ? Math.min(100, (this.framesSent() / k) * 100) : 0;
  });
  readonly throughput = computed(() => this.effectiveBlockSize() * this.fps());

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly stageRef = viewChild<ElementRef<HTMLElement>>('stage');

  private timer: ReturnType<typeof setInterval> | null = null;
  private encoder: LtEncoder | null = null;
  private header: FrameHeader | null = null;
  private seed = 0;
  private scale = 4;
  private version = 0;
  private resizeObserver: ResizeObserver | null = null;
  private busy = false;

  ngOnDestroy(): void {
    this.stop();
  }

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const data = new Uint8Array(await file.arrayBuffer());
    this.setPayload(file.name, file.type || 'application/octet-stream', data);
    input.value = '';
  }

  useText(): void {
    const value = this.text();
    if (!value.trim()) {
      this.error.set('Wpisz jakiś tekst.');
      return;
    }
    this.setPayload('wiadomosc.txt', 'text/plain', utf8Encode(value));
  }

  onTextInput(event: Event): void {
    this.text.set((event.target as HTMLTextAreaElement).value);
  }

  onBlockSize(event: Event): void {
    this.blockSize.set(Number((event.target as HTMLSelectElement).value));
    this.restartIfRunning();
  }

  onFps(event: Event): void {
    this.fps.set(Number((event.target as HTMLInputElement).value));
    if (this.running()) this.scheduleTimer();
  }

  onEcLevel(event: Event): void {
    this.ecLevel.set((event.target as HTMLSelectElement).value as EcLevel);
    this.restartIfRunning();
  }

  start(): void {
    const payload = this.payload();
    if (!payload) return;
    this.stop();
    this.error.set('');

    const blockSize = this.effectiveBlockSize();
    this.encoder = new LtEncoder(payload.packed.bytes, blockSize);
    this.header = {
      fileId: randomUint32(),
      blockCount: this.encoder.blockCount,
      blockSize,
      dataLength: payload.packed.bytes.length,
      flags: payload.packed.flags,
      crc: crc32(payload.packed.bytes),
      seed: 0,
    };
    this.seed = 0;
    this.framesSent.set(0);

    try {
      const probe = QRCode.create([{ mode: 'byte', data: this.frameBytesFor(0) }], {
        errorCorrectionLevel: this.ecLevel(),
      });
      this.version = probe.version;
      this.qrVersion.set(probe.version);
      this.qrModules.set(probe.modules.size);
    } catch (err) {
      this.error.set(
        `Ramka nie mieści się w kodzie QR (${String(err)}). Zmniejsz rozmiar bloku lub poziom korekcji.`,
      );
      return;
    }

    this.running.set(true);
    this.fitScale();
    this.observeStage();
    this.renderNext();
    this.scheduleTimer();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.running.set(false);
  }

  async toggleFullscreen(): Promise<void> {
    const stage = this.stageRef()?.nativeElement;
    if (!stage) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stage.requestFullscreen();
    } catch {
      /* brak API pełnego ekranu np. w iOS Safari */
    }
  }

  private setPayload(name: string, mime: string, data: Uint8Array): void {
    this.stop();
    this.error.set('');
    const packed = packContainer({ name, mime, data });
    this.payload.set({ name, mime, size: data.length, packed });
  }

  private restartIfRunning(): void {
    if (this.running()) this.start();
  }

  private scheduleTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.renderNext(), Math.round(1000 / this.fps()));
  }

  private frameBytesFor(seed: number): Uint8Array {
    const header = { ...this.header!, seed };
    return utf8Encode(bytesToBase64(encodeFrame({ header, payload: this.encoder!.droplet(seed) })));
  }

  private async renderNext(): Promise<void> {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas || !this.encoder || !this.header || this.busy) return;
    this.busy = true;
    try {
      const seed = this.seed;
      this.seed = (this.seed + 1) >>> 0;
      await QRCode.toCanvas(canvas, [{ mode: 'byte', data: this.frameBytesFor(seed) }], {
        errorCorrectionLevel: this.ecLevel(),
        version: this.version,
        scale: this.scale,
        margin: 2,
        color: { dark: '#000000ff', light: '#ffffffff' },
      });
      this.framesSent.update((n) => n + 1);
    } catch (err) {
      this.error.set(String(err));
      this.stop();
    } finally {
      this.busy = false;
    }
  }

  /** Dobiera całkowitą skalę tak, aby moduły QR były ostre i kod mieścił się na scenie. */
  private fitScale(): void {
    const stage = this.stageRef()?.nativeElement;
    const modules = this.qrModules() + 4;
    if (!stage || !modules) return;
    const available = Math.min(stage.clientWidth, stage.clientHeight || stage.clientWidth) - 16;
    this.scale = Math.max(1, Math.floor(available / modules));
  }

  private observeStage(): void {
    const stage = this.stageRef()?.nativeElement;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => this.fitScale());
    this.resizeObserver.observe(stage);
  }
}
