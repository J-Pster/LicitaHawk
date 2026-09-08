import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AccountService, McpInfo } from '../../core/account.service';
import { extractErrorMessage } from '../../core/http-error.util';
import { ToastService } from '../../core/toast.service';
import { CodeBlock, PageHeader, Skeleton } from '../../shared';

/**
 * Tela pensada para quem não é desenvolvedor: conectar o LicitaHawk a um cliente MCP (Claude e
 * outros compatíveis com o protocolo) sem precisar entender a API REST por trás.
 */
@Component({
  selector: 'app-mcp',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, CodeBlock, PageHeader, Skeleton],
  templateUrl: './mcp.html',
  styleUrl: './mcp.scss',
})
export class Mcp implements OnInit {
  private readonly accountService = inject(AccountService);
  private readonly toastService = inject(ToastService);

  readonly info = signal<McpInfo | null>(null);
  readonly loading = signal(true);
  readonly errorMsg = signal<string | null>(null);

  /** Configuração pronta para colar num cliente MCP que fale HTTP remoto (URL + headers), como
   * a maioria dos clientes desktop atuais. A chave real nunca entra aqui: fica um placeholder. */
  readonly configJson = computed(() => {
    const info = this.info();
    if (!info) return '';
    return JSON.stringify(
      {
        mcpServers: {
          licitahawk: {
            url: info.mcp_url,
            headers: {
              Authorization: 'Bearer SUA_API_KEY',
            },
          },
        },
      },
      null,
      2,
    );
  });

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.errorMsg.set(null);
    try {
      this.info.set(await this.accountService.getMcpInfo());
    } catch (err) {
      this.errorMsg.set(extractErrorMessage(err, 'Não foi possível carregar as informações do MCP.'));
    } finally {
      this.loading.set(false);
    }
  }

  async copy(value: string, message = 'Copiado para a área de transferência'): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.toastService.success(message);
    } catch {
      this.toastService.error('Não foi possível copiar');
    }
  }
}
