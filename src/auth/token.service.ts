import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface TokenClaims {
  sub: string; // userId
  orgId: string;
  roleKey: string;
  sessionVersion: number;
}

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  sign(claims: Omit<TokenClaims, 'sessionVersion'> & { sessionVersion?: number }): string {
    return this.jwt.sign({ ...claims, sessionVersion: claims.sessionVersion ?? 0 });
  }

  verify(token: string): TokenClaims {
    const p = this.jwt.verify<TokenClaims & { iat: number; exp: number }>(token);
    return { sub: p.sub, orgId: p.orgId, roleKey: p.roleKey, sessionVersion: p.sessionVersion ?? 0 };
  }
}
