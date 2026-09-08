import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AccountService, CheckoutResult } from '../../../../core/account.service';
import { extractErrorMessage } from '../../../../core/http-error.util';
import { ToastService } from '../../../../core/toast.service';
import { ModalShell, TextField } from '../../../../shared';
import { digitsOnly, formatCpfCnpjInput, validateCpfCnpj } from '../../cpf-cnpj.util';
import { planEntry } from '../../plan-catalog';

type Step = 'form' | 'result';

/** O checkout só existe pra subir de plano -- 'free' nunca chega aqui (ver Account.openCheckout). */
type CheckoutPlan = 'starter' | 'pro';

/**
 * Coleta nome e CPF/CNPJ (o Cognito não fornece nenhum dos dois, mas `POST /checkout` exige
 * ambos) e gera a cobrança. Depois de gerada, mostra o link da fatura (caminho garantido) e o
 * QR code Pix quando ele já tiver chegado -- ele pode atrasar por timing do Asaas, então nunca é
 * a única saída da tela.
 */
@Component({
  selector: 'app-checkout-modal',
  standalone: true,
  imports: [FormsModule, ModalShell, TextField],
  templateUrl: './checkout-modal.html',
  styleUrl: './checkout-modal.scss',
})
export class CheckoutModal {
  private readonly accountService = inject(AccountService);
  private readonly toast = inject(ToastService);

  readonly plan = input.required<CheckoutPlan>();
  readonly closed = output<void>();
  readonly succeeded = output<CheckoutResult>();

  readonly planName = computed(() => planEntry(this.plan()).name);

  readonly step = signal<Step>('form');
  readonly submitting = signal(false);
  readonly formError = signal<string | null>(null);
  readonly nameError = signal<string | null>(null);
  readonly cpfCnpjError = signal<string | null>(null);
  readonly result = signal<CheckoutResult | null>(null);

  name = '';
  cpfCnpj = '';

  onCpfCnpjInput(value: string): void {
    this.cpfCnpj = formatCpfCnpjInput(value);
    if (this.cpfCnpjError()) {
      this.cpfCnpjError.set(null);
    }
  }

  onNameInput(value: string): void {
    this.name = value;
    if (this.nameError()) {
      this.nameError.set(null);
    }
  }

  async submit(): Promise<void> {
    this.formError.set(null);

    const nameOk = this.name.trim().length > 0;
    this.nameError.set(nameOk ? null : 'Informe o nome completo ou razão social.');

    const cpfCnpjMsg = validateCpfCnpj(this.cpfCnpj);
    this.cpfCnpjError.set(cpfCnpjMsg);

    if (!nameOk || cpfCnpjMsg) {
      return;
    }

    this.submitting.set(true);
    try {
      const result = await this.accountService.checkout(this.plan(), digitsOnly(this.cpfCnpj), this.name.trim());
      this.result.set(result);
      this.step.set('result');
      this.succeeded.emit(result);
    } catch (err) {
      this.formError.set(extractErrorMessage(err, 'Não foi possível gerar a cobrança. Tente novamente.'));
    } finally {
      this.submitting.set(false);
    }
  }

  async copyPixPayload(payload: string): Promise<void> {
    await navigator.clipboard.writeText(payload);
    this.toast.success('Código Pix copiado');
  }

  close(): void {
    if (this.submitting()) {
      return;
    }
    this.closed.emit();
  }
}
