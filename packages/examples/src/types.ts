import {UiL2Level} from '@cosmic-lab/prop-shop-sdk';
import {MarketType} from '@drift-labs/sdk';
import {err, ok, Result} from 'neverthrow';

export interface MarketPriceInfo {
  bid: UiL2Level;
  ask: UiL2Level;
  oracle: number;
}

export class RingBuffer<T> {
  private readonly buffer: T[];
  private readonly maxSize: number;
  private currentSize: number;

  constructor(size: number) {
    this.buffer = [];
    this.maxSize = size;
    this.currentSize = 0;
  }

  push(item: T): void {
    if (this.currentSize < this.maxSize) {
      this.buffer.push(item);
      this.currentSize++;
    } else {
      this.buffer.shift();
      this.buffer.push(item);
    }
  }

  pop(): T | undefined {
    if (this.currentSize > 0) {
      this.currentSize--;
      return this.buffer.shift();
    }
    return undefined;
  }

  size(): number {
    return this.currentSize;
  }

  isFull(): boolean {
    return this.currentSize === this.maxSize;
  }

  getBuffer(): T[] {
    return this.buffer;
  }

  get(index: number): T {
    return this.buffer[index];
  }

  clear(): void {
    this.buffer.length = 0;
    this.currentSize = 0;
  }

  last(): Result<T, string> {
    if (this.currentSize === 0) {
      return err('Buffer is empty');
    }
    return ok(this.buffer[this.currentSize - 1]);
  }
}

export enum StandardTimeframe {
  FIVE_SECONDS = 'FIVE_SECONDS',
  ONE_MINUTE = 'ONE_MINUTE',
  FIVE_MINUTES = 'FIVE_MINUTES',
  FIFTEEN_MINUTES = 'FIFTEEN_MINUTES',
  THIRTY_MINUTES = 'THIRTY_MINUTES',
  ONE_HOUR = 'ONE_HOUR',
  FOUR_HOURS = 'FOUR_HOURS',
  ONE_DAY = 'ONE_DAY',
}

export class Timeframe {
  private readonly timeframe: StandardTimeframe;

  constructor(timeframe: StandardTimeframe) {
    this.timeframe = timeframe;
  }

  toUnixSeconds(): number {
    switch (this.timeframe) {
      case StandardTimeframe.FIVE_SECONDS:
        return 5;
      case StandardTimeframe.ONE_MINUTE:
        return 60;
      case StandardTimeframe.FIVE_MINUTES:
        return 5 * 60;
      case StandardTimeframe.ONE_HOUR:
        return 60 * 60;
      case StandardTimeframe.ONE_DAY:
        return 24 * 60 * 60;
      default:
        throw new Error('Invalid timeframe');
    }
  }
}

export class MarketInfo {
  private readonly _marketIndex: number;
  private readonly _marketType: MarketType;

  static spot(marketIndex: number): MarketInfo {
    return new MarketInfo(marketIndex, MarketType.SPOT);
  }

  static perp(marketIndex: number): MarketInfo {
    return new MarketInfo(marketIndex, MarketType.PERP);
  }

  constructor(marketIndex: number, marketType: MarketType) {
    this._marketIndex = marketIndex;
    this._marketType = marketType;
  }

  get marketIndex(): number {
    return this._marketIndex;
  }

  get marketType(): MarketType {
    return this._marketType;
  }

  isPerp(): boolean {
    return this.marketType === MarketType.PERP;
  }
}
