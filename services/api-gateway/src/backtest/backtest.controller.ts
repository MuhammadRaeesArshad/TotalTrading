import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthedUser } from '../auth/jwt.strategy';
import { AccountsService } from '../accounts/accounts.service';
import { BacktestClient } from './backtest.client';
import { BacktestService } from './backtest.service';
import { ArchiveRunDto, ImportBarsDto, StartBacktestDto } from './dto';

/** A year of M5 is ~75k bars per pair; this keeps one request bounded. */
const MAX_SERIES_PER_IMPORT = 200;

@Controller('backtest')
@UseGuards(JwtAuthGuard)
export class BacktestController {
  constructor(
    private readonly engine: BacktestClient,
    private readonly accounts: AccountsService,
    private readonly runs: BacktestService,
  ) {}

  /** Recent history imports, newest first, with live progress. */
  @Get('imports')
  imports() {
    return this.engine.imports();
  }

  /** One import's progress, and its per-series report once finished. */
  @Get('imports/:id')
  importStatus(@Param('id') id: string) {
    return this.engine.importStatus(id);
  }

  /** Detectors the engine can run, with their rule versions. */
  @Get('detectors')
  detectors() {
    return this.engine.detectors();
  }

  @Post('runs')
  startRun(@CurrentUser() user: AuthedUser, @Body() dto: StartBacktestDto) {
    return this.runs.start(user.id, dto);
  }

  /** `?archived=true` returns the put-aside list instead of the working one. */
  @Get('runs')
  listRuns(@CurrentUser() user: AuthedUser, @Query('archived') archived?: string) {
    return this.runs.list(user.id, archived === 'true');
  }

  @Patch('runs/:id/archive')
  archiveRun(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() dto: ArchiveRunDto,
  ) {
    return this.runs.setArchived(user.id, id, dto.archived);
  }

  @Get('runs/:id')
  getRun(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.runs.get(user.id, id);
  }

  @Get('runs/:id/trades')
  listTrades(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.runs.listTrades(user.id, id);
  }

  /** Bars around one trade, for the chart shown beside it. */
  @Get('runs/:id/trades/:tradeId/bars')
  tradeBars(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Param('tradeId') tradeId: string,
  ) {
    return this.runs.tradeBars(user.id, id, tradeId);
  }

  @Delete('runs/:id')
  removeRun(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.runs.remove(user.id, id);
  }

  @Get('health')
  health() {
    return this.engine.health();
  }

  /** What history is already on disk, and therefore what is backtestable. */
  @Get('cache')
  cache() {
    return this.engine.cache();
  }

  /**
   * Backfills the bar cache for one account's symbols.
   *
   * Scoped to an account because that is where the credentials live — the
   * engine needs a live MT5 login to read history, and this is the only place
   * that can decrypt one.
   */
  @Post('accounts/:id/import')
  @HttpCode(200)
  async importBars(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body() dto: ImportBarsDto,
  ) {
    if (dto.fromTs >= dto.toTs) {
      throw new BadRequestException('The start date must come before the end date.');
    }

    const series = dto.symbols.length * dto.timeframes.length;
    if (series > MAX_SERIES_PER_IMPORT) {
      throw new BadRequestException(
        `That is ${series} series in one request. Split it into batches of ${MAX_SERIES_PER_IMPORT} or fewer.`,
      );
    }

    const account = await this.accounts.get(user.id, id);

    // Catch a typo here rather than after the engine has spent minutes on the
    // symbols that do exist.
    if (account.availableSymbols.length) {
      const unknown = dto.symbols.filter(
        (s) => !account.availableSymbols.includes(s),
      );
      if (unknown.length) {
        throw new BadRequestException(
          `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not offered on this account. Reconnect it to refresh the symbol list.`,
        );
      }
    }

    const credentials = await this.accounts.credentialsForImport(user.id, id);

    return this.engine.importBars({
      credentials,
      symbols: dto.symbols,
      timeframes: dto.timeframes,
      from_ts: dto.fromTs,
      to_ts: dto.toTs,
    });
  }
}
