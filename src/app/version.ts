import { FRAME_VERSION } from './core/frame';
import { CALIBRATION_TABLE_VERSION } from './core/profile';

/** Wersja aplikacji pokazywana w stopce; podbijana przy każdej zmianie protokołu. */
export const APP_VERSION = '0.6.0';

export function versionLabel(): string {
  return `v${APP_VERSION} · ramka v${FRAME_VERSION} · tabela v${CALIBRATION_TABLE_VERSION}`;
}
