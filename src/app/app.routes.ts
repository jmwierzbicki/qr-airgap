import { Routes } from '@angular/router';
import { Receive } from './receive/receive';
import { Send } from './send/send';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'send' },
  { path: 'send', component: Send, title: 'QR Airgap – nadawanie' },
  { path: 'receive', component: Receive, title: 'QR Airgap – odbiór' },
  { path: '**', redirectTo: 'send' },
];
