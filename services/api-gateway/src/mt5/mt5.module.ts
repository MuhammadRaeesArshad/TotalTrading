import { Module } from '@nestjs/common';
import { Mt5Client } from './mt5.client';

@Module({
  providers: [Mt5Client],
  exports: [Mt5Client],
})
export class Mt5Module {}
