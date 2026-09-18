import { Module } from '@nestjs/common';
import { Mt5Module } from '../mt5/mt5.module';
import { HealthController } from './health.controller';

@Module({
  imports: [Mt5Module],
  controllers: [HealthController],
})
export class HealthModule {}
