import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { APP_CONFIG } from '../../config';
import { ThemeService } from '../../core/theme.service';

@Component({
  selector: 'app-landing',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
})
export class Landing {
  private readonly themeService = inject(ThemeService);

  /** Vem do APP_CONFIG, nao hardcoded: a porta da API muda por ambiente. */
  readonly docsUrl = `${APP_CONFIG.apiUrl}/docs`;

  readonly themePreference = this.themeService.preference;

  cycleTheme(): void {
    this.themeService.cycle();
  }

  themeLabel(): string {
    switch (this.themePreference()) {
      case 'light':
        return 'Tema claro (clique para escuro)';
      case 'dark':
        return 'Tema escuro (clique para seguir o sistema)';
      default:
        return 'Tema do sistema (clique para claro)';
    }
  }
}
