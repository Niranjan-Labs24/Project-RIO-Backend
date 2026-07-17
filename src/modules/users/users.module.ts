import { Module } from '@nestjs/common';
import { PasswordService } from '../../auth/password.service';
import { MailerModule } from '../../mailer/mailer.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [MailerModule],
  controllers: [UsersController],
  providers: [UsersService, PasswordService],
})
export class UsersModule {}
