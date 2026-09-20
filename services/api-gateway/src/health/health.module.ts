import { Module } from '@nestjs/common';
import { Mt5Module } from '../mt5/mt5.module';
import { BacktestModule } from '../backtest/backtest.module';
import { AiModule } from '../ai/ai.module';
import { HealthController } from './health.controller';

@Module({
  imports: [Mt5Module, BacktestModule, AiModule],
  controllers: [HealthController],
})
export class HealthModule {}
