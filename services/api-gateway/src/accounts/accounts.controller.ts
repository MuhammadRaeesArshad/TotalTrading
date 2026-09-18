import {
  Body, Controller, Delete, Get, HttpCode, Param,
  Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthedUser } from '../auth/jwt.strategy';
import { AccountsService } from './accounts.service';
import { CandlesQueryDto, CreateAccountDto, UpdateAccountDto } from './dto';

@Controller('accounts')
@UseGuards(JwtAuthGuard)
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  list(@CurrentUser() user: AuthedUser) {
    return this.accounts.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthedUser, @Body() dto: CreateAccountDto) {
    return this.accounts.create(user.id, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.accounts.get(user.id, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() dto: UpdateAccountDto,
  ) {
    return this.accounts.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.accounts.remove(user.id, id);
  }

  /** Logs in, snapshots the balance, and refreshes the broker's symbol list. */
  @Post(':id/connect')
  @HttpCode(200)
  connect(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.accounts.connect(user.id, id);
  }

  @Post(':id/refresh')
  @HttpCode(200)
  refresh(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.accounts.refreshSnapshot(user.id, id);
  }

  @Get(':id/instruments')
  instruments(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Query('forexOnly') forexOnly?: string,
  ) {
    return this.accounts
      .get(user.id, id)
      .then(() => this.accounts.listInstruments(id, forexOnly === 'true'));
  }

  @Get(':id/candles')
  candles(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Query() query: CandlesQueryDto,
  ) {
    return this.accounts.candles(user.id, id, query);
  }
}
