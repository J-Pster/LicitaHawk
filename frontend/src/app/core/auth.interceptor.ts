import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { from, switchMap } from 'rxjs';
import { AuthService } from './auth.service';
import { APP_CONFIG } from '../config';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(`${APP_CONFIG.apiUrl}/v1/account`)) {
    return next(req);
  }

  const authService = inject(AuthService);
  return from(authService.getIdToken()).pipe(
    switchMap((idToken) => {
      if (!idToken) {
        return next(req);
      }
      return next(
        req.clone({
          setHeaders: { Authorization: `Bearer ${idToken}` },
        }),
      );
    }),
  );
};
