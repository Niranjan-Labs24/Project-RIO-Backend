import { Module } from '@nestjs/common';
import { PasswordService } from '../../auth/password.service';
import { MailerModule } from '../../mailer/mailer.module';
import { CitizenController } from './citizen.controller';
import { CitizenService } from './citizen.service';

@Module({
  imports: [MailerModule],
  controllers: [CitizenController],
  providers: [CitizenService, PasswordService],
})
export class CitizenModule {}
