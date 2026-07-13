import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordService {
  // Lazily-computed argon2id hash of a throwaway secret. Verifying against it on
  // the "user not found / no password" login path equalises response time with
  // the real-user path, mitigating username enumeration via timing.
  private dummyHash?: Promise<string>;

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  // Always returns false; exists only to burn a comparable amount of CPU as a
  // real verify so the not-found path is not observably faster.
  async verifyDummy(plain: string): Promise<false> {
    this.dummyHash ??= argon2.hash('argon2-timing-equaliser', { type: argon2.argon2id });
    await this.verify(await this.dummyHash, plain);
    return false;
  }
}
