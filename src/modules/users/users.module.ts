import { Module } from '@nestjs/common';
import { PasswordService } from '../../auth/password.service';
import { MailerModule } from '../../mailer/mailer.module';
import { TranslationModule } from '../translation/translation.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [MailerModule, TranslationModule],
  controllers: [UsersController],
  providers: [UsersService, PasswordService],
  exports: [UsersService],
})
export class UsersModule {}
