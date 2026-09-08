import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { inject } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import { AccountService } from '../../core/account.service';
import { mapCognitoError } from '../../core/cognito-error.util';

type Mode = 'login' | 'signup' | 'confirm';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  private readonly authService = inject(AuthService);
  private readonly accountService = inject(AccountService);
  private readonly router = inject(Router);

  readonly mode = signal<Mode>('login');
  readonly loading = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly infoMsg = signal<string | null>(null);

  email = '';
  password = '';
  confirmPassword = '';
  confirmationCode = '';

  setMode(mode: Mode): void {
    this.mode.set(mode);
    this.errorMsg.set(null);
    this.infoMsg.set(null);
  }

  async onLogin(): Promise<void> {
    this.errorMsg.set(null);
    this.infoMsg.set(null);
    if (!this.email || !this.password) {
      this.errorMsg.set('Informe email e senha.');
      return;
    }

    this.loading.set(true);
    try {
      await this.authService.login(this.email, this.password);
      await this.accountService.provision();
      await this.router.navigate(['/app/dashboard']);
    } catch (err) {
      const cognitoErr = err as { code?: string };
      if (cognitoErr.code === 'UserNotConfirmedException') {
        this.mode.set('confirm');
        this.infoMsg.set('Sua conta ainda não foi confirmada. Digite o código enviado por email.');
      } else {
        this.errorMsg.set(mapCognitoError(err));
      }
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Dev-only: loga direto com o usuario de teste ja confirmado no User Pool
   * (criado via admin-create-user, sem depender de receber email real) pra
   * ver o dashboard sem precisar passar pelo fluxo de cadastro inteiro.
   */
  async loginAsTestUser(): Promise<void> {
    this.email = 'teste@licitahawk.local';
    this.password = 'SenhaTeste123';
    await this.onLogin();
  }

  /**
   * Dev-only: preenche uma senha valida nos dois campos de cadastro e foca o
   * email, pra so precisar digitar um email de verdade (o Cognito manda um
   * codigo real pra ele) e ver a tela de cadastro -> confirmacao -> dashboard
   * sem ficar inventando senha que bata com a politica do pool toda vez.
   */
  fillTestSignupData(): void {
    this.password = 'LicitaHawkTeste1';
    this.confirmPassword = 'LicitaHawkTeste1';
    this.infoMsg.set('Senha de teste preenchida. Digite um email de verdade pra receber o código.');
    queueMicrotask(() => document.getElementById('signup-email')?.focus());
  }

  async onSignup(): Promise<void> {
    this.errorMsg.set(null);
    this.infoMsg.set(null);

    if (!this.email || !this.password || !this.confirmPassword) {
      this.errorMsg.set('Preencha todos os campos.');
      return;
    }
    if (this.password !== this.confirmPassword) {
      this.errorMsg.set('As senhas não coincidem.');
      return;
    }
    if (!this.isPasswordStrongEnough(this.password)) {
      this.errorMsg.set(
        'A senha precisa ter no mínimo 8 caracteres, com letra maiúscula, minúscula e número.',
      );
      return;
    }

    this.loading.set(true);
    try {
      await this.authService.signUp(this.email, this.password);
      this.mode.set('confirm');
      this.infoMsg.set(`Enviamos um código de confirmação para ${this.email}.`);
    } catch (err) {
      this.errorMsg.set(mapCognitoError(err));
    } finally {
      this.loading.set(false);
    }
  }

  async onConfirm(): Promise<void> {
    this.errorMsg.set(null);
    this.infoMsg.set(null);

    if (!this.confirmationCode) {
      this.errorMsg.set('Informe o código recebido por email.');
      return;
    }

    this.loading.set(true);
    try {
      await this.authService.confirmSignUp(this.email, this.confirmationCode);
      this.mode.set('login');
      this.infoMsg.set('Conta confirmada com sucesso. Faça login para continuar.');
      this.confirmationCode = '';
    } catch (err) {
      this.errorMsg.set(mapCognitoError(err));
    } finally {
      this.loading.set(false);
    }
  }

  async onResendCode(): Promise<void> {
    this.errorMsg.set(null);
    this.infoMsg.set(null);
    this.loading.set(true);
    try {
      await this.authService.resendConfirmationCode(this.email);
      this.infoMsg.set('Novo código enviado para o seu email.');
    } catch (err) {
      this.errorMsg.set(mapCognitoError(err));
    } finally {
      this.loading.set(false);
    }
  }

  private isPasswordStrongEnough(password: string): boolean {
    return (
      password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password)
    );
  }
}
