import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { BacktestClient } from './backtest.client';
import { BacktestController } from './backtest.controller';

@Module({
  imports: [AccountsModule],
  controllers: [BacktestController],
  providers: [BacktestClient],
  exports: [BacktestClient],
})
export class BacktestModule {}
