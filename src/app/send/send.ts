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
import { crc32, formatBytes, randomUint32, utf8Encode } from '../core/bytes';
import { packContainer, type PackedContainer } from '../core/container';
import { FLAG_CALIBRATION, HEADER_SIZE, type FrameHeader } from '../core/frame';
import { LtEncoder } from '../core/lt';
import {
  CALIBRATION_MS,
  CALIBRATION_PROFILES,
  CALIBRATION_TABLE_VERSION,
  DEFAULT_PROFILE,
  calibrationCodes,
  calibrationDurationMs,
  calibrationPayload,
  profileByName,
  profileName,
  type Grid,
  type Profile,
} from '../core/profile';
import { encodeWire } from '../core/wire';

interface PreparedPayload {
  name: string;
  mime: string;
  size: number;
  packed: PackedContainer;
}

type EcLevel = 'L' | 'M' | 'Q';

export const BLOCK_PRESETS = [200, 400, 700, 1000, 1400, 2000];
const PROFILE_STORAGE_KEY = 'qr-airgap.profile';

interface CodeLayout {
  version: number;
  modules: number;
  margin: number;
  scale: number;
  cols: number;
  rows: number;
}

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
  readonly profileNames = CALIBRATION_PROFILES.map((p) => profileName(p)!);
  readonly calibrationTotalSeconds = Math.round(calibrationDurationMs() / 1000);

  readonly text = signal('');
  readonly payload = signal<PreparedPayload | null>(null);
  readonly profile = signal<Profile>(loadProfile());
  readonly profileInput = signal('');
  readonly ecLevel = signal<EcLevel>('L');
  readonly running = signal(false);
  readonly calibrating = signal(false);
  readonly calibrationIndex = signal(0);
  readonly framesSent = signal(0);
  readonly qrVersion = signal(0);
  readonly qrModules = signal(0);
  readonly error = signal('');
  readonly notice = signal('');

  readonly blockSize = computed(() => this.profile().blockSize);
  readonly fps = computed(() => this.profile().fps);
  readonly grid = computed(() => this.profile().grid);
  readonly binary = computed(() => this.profile().binary);
  readonly currentProfileName = computed(() => profileName(this.profile()));

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
  readonly codesPerSecond = computed(() => this.fps() * this.grid());
  readonly cycleSeconds = computed(() => this.blockCount() / this.codesPerSecond());
  readonly cycleProgress = computed(() => {
    const k = this.blockCount();
    return k ? Math.min(100, (this.framesSent() / k) * 100) : 0;
  });
  readonly throughput = computed(() => this.effectiveBlockSize() * this.codesPerSecond());
  readonly calibrationProfileName = computed(
    () => profileName(CALIBRATION_PROFILES[this.calibrationIndex()]) ?? '',
  );
  readonly calibrationProgress = computed(
    () => (this.calibrationIndex() / CALIBRATION_PROFILES.length) * 100,
  );

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly stageRef = viewChild<ElementRef<HTMLElement>>('stage');

  private timer: ReturnType<typeof setInterval> | null = null;
  private encoder: LtEncoder | null = null;
  private header: FrameHeader | null = null;
  private seed = 0;
  private layout: CodeLayout | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private busy = false;
  private readonly scratch = document.createElement('canvas');
  private calibrationStartedAt = 0;
  private calibrationCodeIndex = 0;

  ngOnDestroy(): void {
    this.stop();
  }

  // --- źródło danych -------------------------------------------------------

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

  // --- parametry -----------------------------------------------------------

  onProfileInput(event: Event): void {
    this.profileInput.set((event.target as HTMLInputElement).value);
  }

  applyProfileName(): void {
    const found = profileByName(this.profileInput());
    if (!found) {
      this.error.set(`Nie znam profilu "${this.profileInput()}". Nazwy to np. ${this.profileNames[0]}.`);
      return;
    }
    this.error.set('');
    this.notice.set(
      `Profil ${profileName(found)}: ${found.blockSize} B, ${found.fps} kl/s, ${found.grid} kod(y) na klatkę, ${found.binary ? 'binarny' : 'base64'}.`,
    );
    this.updateProfile(found);
  }

  onBlockSize(event: Event): void {
    this.updateProfile({ ...this.profile(), blockSize: Number((event.target as HTMLSelectElement).value) });
  }

  onFps(event: Event): void {
    this.updateProfile({ ...this.profile(), fps: Number((event.target as HTMLInputElement).value) });
  }

  onGrid(event: Event): void {
    this.updateProfile({ ...this.profile(), grid: Number((event.target as HTMLSelectElement).value) as Grid });
  }

  onBinary(event: Event): void {
    this.updateProfile({ ...this.profile(), binary: (event.target as HTMLSelectElement).value === 'binary' });
  }

  onEcLevel(event: Event): void {
    this.ecLevel.set((event.target as HTMLSelectElement).value as EcLevel);
    this.restartIfRunning();
  }

  private updateProfile(p: Profile): void {
    this.profile.set(p);
    saveProfile(p);
    this.restartIfRunning();
  }

  // --- nadawanie -----------------------------------------------------------

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
    if (!this.prepareLayout(blockSize, this.grid(), this.binary())) return;

    this.running.set(true);
    this.observeStage();
    this.renderNext();
    this.scheduleTimer(this.fps());
  }

  startCalibration(): void {
    this.stop();
    this.error.set('');
    this.notice.set('');
    this.calibrationIndex.set(0);
    this.framesSent.set(0);
    this.calibrating.set(true);
    this.running.set(true);
    this.observeStage();
    this.enterCalibrationProfile(0);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.running.set(false);
    this.calibrating.set(false);
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
    if (this.calibrating()) return;
    if (this.running()) this.start();
  }

  private scheduleTimer(fps: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.renderNext(), Math.round(1000 / fps));
  }

  /** Wyznacza wersję QR dla ramki o zadanym rozmiarze i skalę, żeby siatka mieściła się na scenie. */
  private prepareLayout(blockSize: number, grid: Grid, binary: boolean): boolean {
    const probeHeader: FrameHeader = {
      fileId: 0,
      blockCount: 1,
      blockSize,
      dataLength: 0,
      flags: 0,
      crc: 0,
      seed: 0,
    };
    const probeWire = encodeWire({ header: probeHeader, payload: new Uint8Array(blockSize) }, binary);
    try {
      const probe = QRCode.create([{ mode: 'byte', data: probeWire }], {
        errorCorrectionLevel: this.ecLevel(),
      });
      const cols = grid === 1 ? 1 : 2;
      const rows = grid === 4 ? 2 : 1;
      this.layout = { version: probe.version, modules: probe.modules.size, margin: 3, scale: 2, cols, rows };
      this.qrVersion.set(probe.version);
      this.qrModules.set(probe.modules.size);
      this.fitScale();
      return true;
    } catch (err) {
      this.error.set(
        `Ramka ${HEADER_SIZE + blockSize} B nie mieści się w kodzie QR (${String(err)}). Zmniejsz rozmiar bloku, użyj trybu binarnego lub niższej korekcji.`,
      );
      this.stop();
      return false;
    }
  }

  private renderNext(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas || !this.layout || this.busy) return;
    this.busy = true;
    try {
      if (this.calibrating()) this.renderCalibrationFrame(canvas);
      else this.renderTransferFrame(canvas);
    } catch (err) {
      this.error.set(String(err));
      this.stop();
    } finally {
      this.busy = false;
    }
  }

  private renderTransferFrame(canvas: HTMLCanvasElement): void {
    if (!this.encoder || !this.header) return;
    const wires: Uint8Array[] = [];
    for (let i = 0; i < this.grid(); i++) {
      const seed = this.seed;
      this.seed = (this.seed + 1) >>> 0;
      wires.push(
        encodeWire({ header: { ...this.header, seed }, payload: this.encoder.droplet(seed) }, this.binary()),
      );
    }
    this.drawCodes(canvas, wires);
    this.framesSent.update((n) => n + wires.length);
  }

  private renderCalibrationFrame(canvas: HTMLCanvasElement): void {
    const idx = this.calibrationIndex();
    const profile = CALIBRATION_PROFILES[idx];
    const total = calibrationCodes(profile);
    const elapsed = performance.now() - this.calibrationStartedAt;
    if (elapsed >= CALIBRATION_MS || this.calibrationCodeIndex >= total) {
      if (idx + 1 >= CALIBRATION_PROFILES.length) {
        this.stop();
        this.notice.set(
          'Kalibracja zakończona. Odczytaj ranking na odbiorniku i wpisz nazwę najlepszego profilu powyżej.',
        );
        return;
      }
      this.calibrationIndex.set(idx + 1);
      this.enterCalibrationProfile(idx + 1);
      return;
    }
    const wires: Uint8Array[] = [];
    for (let i = 0; i < profile.grid && this.calibrationCodeIndex < total; i++) {
      const seed = this.calibrationCodeIndex++;
      const header: FrameHeader = {
        fileId: idx,
        blockCount: total,
        blockSize: profile.blockSize,
        dataLength: CALIBRATION_TABLE_VERSION,
        flags: FLAG_CALIBRATION,
        crc: 0,
        seed,
      };
      wires.push(
        encodeWire({ header, payload: calibrationPayload(idx, seed, profile.blockSize) }, profile.binary),
      );
    }
    this.drawCodes(canvas, wires);
    this.framesSent.update((n) => n + wires.length);
  }

  private enterCalibrationProfile(idx: number): void {
    const profile = CALIBRATION_PROFILES[idx];
    this.calibrationStartedAt = performance.now();
    this.calibrationCodeIndex = 0;
    if (!this.prepareLayout(profile.blockSize, profile.grid, profile.binary)) return;
    this.scheduleTimer(profile.fps);
    // Pierwsza klatka profilu od razu, bez czekania na pierwszy tik timera.
    this.busy = false;
    this.renderCalibrationFrameSafe();
  }

  private renderCalibrationFrameSafe(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas || !this.layout) return;
    try {
      this.renderCalibrationFrame(canvas);
    } catch (err) {
      this.error.set(String(err));
      this.stop();
    }
  }

  /** Rysuje jeden lub kilka kodów QR na wspólnym płótnie, ostrymi modułami o całkowitej skali. */
  private drawCodes(canvas: HTMLCanvasElement, wires: Uint8Array[]): void {
    const layout = this.layout!;
    const cellModules = layout.modules + 2 * layout.margin;
    const cellPx = cellModules * layout.scale;
    const width = layout.cols * cellPx;
    const height = layout.rows * cellPx;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);

    const size = layout.modules;
    if (this.scratch.width !== size) {
      this.scratch.width = size;
      this.scratch.height = size;
    }
    const sctx = this.scratch.getContext('2d')!;
    const image = sctx.createImageData(size, size);

    wires.forEach((wire, i) => {
      const code = QRCode.create([{ mode: 'byte', data: wire }], {
        errorCorrectionLevel: this.ecLevel(),
        version: layout.version,
      });
      const data = code.modules.data;
      const px = image.data;
      for (let m = 0; m < size * size; m++) {
        const v = data[m] ? 0 : 255;
        px[m * 4] = v;
        px[m * 4 + 1] = v;
        px[m * 4 + 2] = v;
        px[m * 4 + 3] = 255;
      }
      sctx.putImageData(image, 0, 0);
      const col = i % layout.cols;
      const row = Math.floor(i / layout.cols);
      const x = col * cellPx + layout.margin * layout.scale;
      const y = row * cellPx + layout.margin * layout.scale;
      ctx.drawImage(this.scratch, x, y, size * layout.scale, size * layout.scale);
    });
  }

  /** Dobiera całkowitą skalę modułu tak, aby cała siatka mieściła się na scenie. */
  private fitScale(): void {
    const stage = this.stageRef()?.nativeElement;
    const layout = this.layout;
    if (!stage || !layout) return;
    const cellModules = layout.modules + 2 * layout.margin;
    const availW = stage.clientWidth - 16;
    const availH = (stage.clientHeight || stage.clientWidth) - 16;
    const scale = Math.floor(
      Math.min(availW / (layout.cols * cellModules), availH / (layout.rows * cellModules)),
    );
    layout.scale = Math.max(1, scale);
  }

  private observeStage(): void {
    const stage = this.stageRef()?.nativeElement;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.fitScale());
    this.resizeObserver.observe(stage);
  }
}

function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return DEFAULT_PROFILE;
    const p = JSON.parse(raw) as Partial<Profile>;
    if (
      typeof p.blockSize === 'number' &&
      typeof p.fps === 'number' &&
      (p.grid === 1 || p.grid === 2 || p.grid === 4) &&
      typeof p.binary === 'boolean'
    ) {
      return { blockSize: p.blockSize, fps: p.fps, grid: p.grid, binary: p.binary };
    }
  } catch {
    /* brak localStorage albo uszkodzony zapis */
  }
  return DEFAULT_PROFILE;
}

function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignoruj */
  }
}
