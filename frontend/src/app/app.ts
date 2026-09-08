import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './core/theme.service';
import { ToastHost } from './shared/toast/toast-host';

@Component({
  imports: [RouterOutlet, ToastHost],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  // Injetado so pra existir desde o boot: o construtor do service aplica o
  // data-theme salvo antes da primeira tela pintar.
  private readonly theme = inject(ThemeService);
}
