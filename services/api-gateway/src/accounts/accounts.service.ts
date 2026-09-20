import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Instrument, InstrumentClass, InstrumentDocument,
  Mt5Account, Mt5AccountDocument, Mt5ConnectionState,
} from '../schemas';
import { CryptoService } from '../common/crypto.service';
import { Mt5Client, Mt5Credentials } from '../mt5/mt5.client';
import type { Mt5SymbolInfo } from '../mt5/mt5.types';
import { CandlesQueryDto, CreateAccountDto, UpdateAccountDto } from './dto';

/** The 7 currencies whose pairings make up the majors and minors. */
const MAJOR_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];
const MAJOR_PAIRS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD',
];
/** Not a currency pair, but it trades like one and it is asked for by name. */
const METALS = ['XAUUSD'];

@Injectable()
export class AccountsService {
  private readonly log = new Logger(AccountsService.name);

  constructor(
    @InjectModel(Mt5Account.name)
    private readonly accounts: Model<Mt5AccountDocument>,
    @InjectModel(Instrument.name)
    private readonly instruments: Model<InstrumentDocument>,
    private readonly crypto: CryptoService,
    private readonly mt5: Mt5Client,
  ) {}

  list(userId: string) {
    return this.accounts
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .exec();
  }

  async get(userId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('No account with that id.');
    }
    const account = await this.accounts
      .findOne({ _id: id, userId: new Types.ObjectId(userId) })
      .exec();
    if (!account) throw new NotFoundException('No account with that id.');
    return account;
  }

  async create(userId: string, dto: CreateAccountDto) {
    const duplicate = await this.accounts
      .findOne({
        userId: new Types.ObjectId(userId),
        login: dto.login,
        server: dto.server,
      })
      .exec();

    if (duplicate) {
      throw new ConflictException(
        `Login ${dto.login} on ${dto.server} is already connected as "${duplicate.label}".`,
      );
    }

    return this.accounts.create({
      userId: new Types.ObjectId(userId),
      label: dto.label,
      login: dto.login,
      server: dto.server,
      passwordCiphertext: this.crypto.encrypt(dto.password),
      mode: dto.mode,
      broker: dto.broker ?? null,
    });
  }

  async update(userId: string, id: string, dto: UpdateAccountDto) {
    const account = await this.get(userId, id);

    if (dto.label !== undefined) account.label = dto.label;
    if (dto.mode !== undefined) account.mode = dto.mode;
    if (dto.isActive !== undefined) account.isActive = dto.isActive;
    if (dto.password !== undefined) {
      account.passwordCiphertext = this.crypto.encrypt(dto.password);
      // Credentials changed — the old connection state says nothing about the new ones.
      account.connectionState = Mt5ConnectionState.NEVER_CONNECTED;
      account.lastError = null;
    }

    await account.save();
    return account;
  }

  async remove(userId: string, id: string) {
    const account = await this.get(userId, id);
    await this.instruments.deleteMany({ accountId: account._id }).exec();
    await account.deleteOne();
  }

  /**
   * Logs into MT5, stores the balance snapshot, and replaces the instrument
   * list with whatever the broker actually offers. Called on demand from the
   * Accounts page — this is the one place symbols enter the system (spec §6.7).
   */
  async connect(userId: string, id: string) {
    const account = await this.get(userId, id);
    const creds = await this.credentialsFor(account._id.toString(), userId);

    try {
      const info = await this.mt5.accountInfo(creds);
      const symbols = await this.mt5.symbols(creds);

      account.connectionState = Mt5ConnectionState.CONNECTED;
      account.lastConnectedAt = new Date();
      account.lastError = null;
      account.broker = info.company || account.broker;
      account.availableSymbols = symbols.map((s) => s.name).sort();
      account.snapshot = {
        balance: info.balance,
        equity: info.equity,
        margin: info.margin,
        marginFree: info.margin_free,
        marginLevel: info.margin_level,
        profit: info.profit,
        currency: info.currency,
        leverage: info.leverage,
        tradeAllowed: info.trade_allowed,
        capturedAt: new Date(),
      };
      await account.save();

      await this.syncInstruments(account._id, symbols);

      return account;
    } catch (err) {
      account.connectionState = Mt5ConnectionState.ERROR;
      account.lastError = err instanceof Error ? err.message : 'Unknown error';
      await account.save();
      throw err;
    }
  }

  async refreshSnapshot(userId: string, id: string) {
    const account = await this.get(userId, id);
    const creds = await this.credentialsFor(account._id.toString(), userId);
    const info = await this.mt5.accountInfo(creds);

    account.snapshot = {
      balance: info.balance,
      equity: info.equity,
      margin: info.margin,
      marginFree: info.margin_free,
      marginLevel: info.margin_level,
      profit: info.profit,
      currency: info.currency,
      leverage: info.leverage,
      tradeAllowed: info.trade_allowed,
      capturedAt: new Date(),
    };
    account.connectionState = Mt5ConnectionState.CONNECTED;
    account.lastConnectedAt = new Date();
    await account.save();

    return account;
  }

  /**
   * `onlyForex` means "the instruments this system knows how to price", which
   * now includes gold — it is not a currency pair, but the engine has a point
   * size for it and it is asked for by name. A broker's thousands of CFDs and
   * indices stay out, because nothing here prices them.
   */
  listInstruments(accountId: string, onlyForex = false) {
    const filter: Record<string, unknown> = {
      accountId: new Types.ObjectId(accountId),
    };
    if (onlyForex) {
      filter.instrumentClass = {
        $in: [InstrumentClass.MAJOR, InstrumentClass.MINOR, InstrumentClass.METAL],
      };
    }
    return this.instruments.find(filter).sort({ symbol: 1 }).exec();
  }

  async candles(userId: string, id: string, query: CandlesQueryDto) {
    const account = await this.get(userId, id);

    if (
      account.availableSymbols.length &&
      !account.availableSymbols.includes(query.symbol)
    ) {
      throw new BadRequestException(
        `${query.symbol} is not offered on this account. Reconnect to refresh the symbol list.`,
      );
    }

    const creds = await this.credentialsFor(account._id.toString(), userId);
    return this.mt5.candles(creds, query.symbol, query.timeframe, query.count ?? 500);
  }

  /**
   * Credentials for an import run, decrypted.
   *
   * Public because the backtest engine has to log into MT5 itself to read
   * history — it cannot borrow the gateway's session. This is the only way out
   * of this service for a plaintext password, which is why it is one named
   * method rather than a general accessor.
   */
  credentialsForImport(userId: string, id: string): Promise<Mt5Credentials> {
    return this.credentialsFor(id, userId);
  }

  /** Decrypts on the way out. Nothing above this layer sees the plaintext password. */
  private async credentialsFor(id: string, userId: string): Promise<Mt5Credentials> {
    const withSecret = await this.accounts
      .findOne({ _id: id, userId: new Types.ObjectId(userId) })
      .select('+passwordCiphertext')
      .exec();

    if (!withSecret) throw new NotFoundException('No account with that id.');

    return {
      login: withSecret.login,
      password: this.crypto.decrypt(withSecret.passwordCiphertext),
      server: withSecret.server,
    };
  }

  private async syncInstruments(
    accountId: Types.ObjectId,
    symbols: Mt5SymbolInfo[],
  ) {
    const ops = symbols.map((s) => {
      const normalized = this.normalizePair(s.name);
      return {
        updateOne: {
          filter: { accountId, symbol: s.name },
          update: {
            $set: {
              accountId,
              symbol: s.name,
              normalizedPair: normalized,
              instrumentClass: this.classify(normalized),
              baseCurrency: s.base_currency,
              quoteCurrency: s.profit_currency,
              digits: s.digits,
              pointSize: s.point,
              contractSize: s.trade_contract_size,
              volumeMin: s.volume_min,
              volumeMax: s.volume_max,
              volumeStep: s.volume_step,
              selected: s.selected,
              tradable: s.trade_allowed,
              swapLong: s.swap_long ?? null,
              swapShort: s.swap_short ?? null,
              swapTripleWeekday: s.swap_triple_weekday ?? null,
            },
          },
          upsert: true,
        },
      };
    });

    if (!ops.length) return;
    const result = await this.instruments.bulkWrite(ops, { ordered: false });
    this.log.log(
      `Synced ${symbols.length} symbols for account ${accountId.toString()} ` +
        `(${result.upsertedCount} new)`,
    );
  }

  /**
   * Strips broker suffixes so EURUSD, EURUSD.r and EURUSDm all group together.
   * Returns null for anything that isn't a recognisable FX pair.
   */
  private normalizePair(symbol: string): string | null {
    const core = symbol.toUpperCase().replace(/[^A-Z]/g, '');
    if (core.length < 6) return null;
    const candidate = core.slice(0, 6);
    if (METALS.includes(candidate)) return candidate;

    const base = candidate.slice(0, 3);
    const quote = candidate.slice(3, 6);
    if (!MAJOR_CURRENCIES.includes(base) || !MAJOR_CURRENCIES.includes(quote)) {
      return null;
    }
    return candidate;
  }

  private classify(normalized: string | null): InstrumentClass {
    if (!normalized) return InstrumentClass.OTHER;
    if (METALS.includes(normalized)) return InstrumentClass.METAL;
    if (MAJOR_PAIRS.includes(normalized)) return InstrumentClass.MAJOR;
    // Both legs are major currencies but neither side is USD — that's a cross/minor.
    return InstrumentClass.MINOR;
  }
}
