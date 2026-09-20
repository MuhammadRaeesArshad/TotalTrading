import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccountsModule } from '../accounts/accounts.module';
import { Backtest, BacktestSchema, Sweep, SweepSchema, Trade, TradeSchema } from '../schemas';
import { BacktestClient } from './backtest.client';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';

@Module({
  imports: [
    AccountsModule,
    MongooseModule.forFeature([
      { name: Backtest.name, schema: BacktestSchema },
      { name: Trade.name, schema: TradeSchema },
    ]),
  ],
  controllers: [BacktestController],
  providers: [BacktestClient, BacktestService],
  exports: [BacktestClient],
})
export class BacktestModule {}
