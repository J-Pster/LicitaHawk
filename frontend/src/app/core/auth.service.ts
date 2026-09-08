import { Injectable, signal } from '@angular/core';
import {
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  CognitoUserSession,
  AuthenticationDetails,
} from 'amazon-cognito-identity-js';
import { APP_CONFIG } from '../config';

const userPool = new CognitoUserPool({
  UserPoolId: APP_CONFIG.cognito.userPoolId,
  ClientId: APP_CONFIG.cognito.clientId,
});

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly currentEmail = signal<string | null>(null);

  signUp(email: string, password: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const attributes = [
        new CognitoUserAttribute({ Name: 'email', Value: email }),
      ];
      userPool.signUp(email, password, attributes, [], (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  confirmSignUp(email: string, code: string): Promise<void> {
    const cognitoUser = new CognitoUser({ Username: email, Pool: userPool });
    return new Promise((resolve, reject) => {
      cognitoUser.confirmRegistration(code, true, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  resendConfirmationCode(email: string): Promise<void> {
    const cognitoUser = new CognitoUser({ Username: email, Pool: userPool });
    return new Promise((resolve, reject) => {
      cognitoUser.resendConfirmationCode((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  login(email: string, password: string): Promise<CognitoUserSession> {
    const cognitoUser = new CognitoUser({ Username: email, Pool: userPool });
    const authDetails = new AuthenticationDetails({
      Username: email,
      Password: password,
    });
    return new Promise((resolve, reject) => {
      cognitoUser.authenticateUser(authDetails, {
        onSuccess: (session) => {
          this.currentEmail.set(email);
          resolve(session);
        },
        onFailure: (err) => reject(err),
      });
    });
  }

  logout(): void {
    const cognitoUser = userPool.getCurrentUser();
    cognitoUser?.signOut();
    this.currentEmail.set(null);
  }

  getSession(): Promise<CognitoUserSession | null> {
    const cognitoUser = userPool.getCurrentUser();
    if (!cognitoUser) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      cognitoUser.getSession(
        (err: Error | null, session: CognitoUserSession | null) => {
          if (err) {
            reject(err);
            return;
          }
          if (session?.isValid()) {
            this.currentEmail.set(cognitoUser.getUsername());
            resolve(session);
          } else {
            resolve(null);
          }
        },
      );
    });
  }

  async getIdToken(): Promise<string | null> {
    try {
      const session = await this.getSession();
      return session?.getIdToken().getJwtToken() ?? null;
    } catch {
      return null;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.getIdToken()) !== null;
  }
}
