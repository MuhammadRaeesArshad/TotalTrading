import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Instrument, InstrumentSchema, Mt5Account, Mt5AccountSchema,
} from '../schemas';
import { Mt5Module } from '../mt5/mt5.module';
import { AccountsService } from './accounts.service';
import { AccountsController } from './accounts.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Mt5Account.name, schema: Mt5AccountSchema },
      { name: Instrument.name, schema: InstrumentSchema },
    ]),
    Mt5Module,
  ],
  controllers: [AccountsController],
  providers: [AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}
