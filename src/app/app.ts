import { ChangeDetectionStrategy, Component, inject, isDevMode, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { versionLabel } from './version';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  readonly version = versionLabel();
  readonly updating = signal(false);
  private readonly updates = inject(SwUpdate);

  constructor() {
    if (isDevMode() || !this.updates.isEnabled) return;
    // Obie strony transferu muszą mieć ten sam protokół, więc nowa wersja wchodzi od razu.
    this.updates.versionUpdates.subscribe((event) => {
      if (event.type === 'VERSION_READY') {
        this.updating.set(true);
        void this.updates.activateUpdate().then(() => document.location.reload());
      }
    });
    void this.updates.checkForUpdate().catch(() => undefined);
    setInterval(() => void this.updates.checkForUpdate().catch(() => undefined), 60_000);
  }
}
