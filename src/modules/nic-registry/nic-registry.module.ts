import { Module } from '@nestjs/common';
import { NicRegistryService } from './nic-registry.service';

// No controller of its own: the only HTTP surface is
// POST /auth/verify-registration-number on AuthController (the signup form's
// Verify button), which answers with a bare verdict and no registry data.
// Nothing here exposes the register itself — a browsable/searchable endpoint
// would turn 7,800-odd entity records into something enumerable through the
// API for no product reason.
@Module({
  providers: [NicRegistryService],
  exports: [NicRegistryService],
})
export class NicRegistryModule {}
