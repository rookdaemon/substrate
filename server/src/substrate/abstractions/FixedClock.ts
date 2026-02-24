import { IClock } from "./IClock";

export class FixedClock implements IClock {
  private date: Date;

  constructor(date: Date) {
    this.date = date;
  }

  now(): Date {
    return this.date;
  }

  setNow(date: Date): void {
    this.date = date;
  }

  advance(ms: number): void {
    this.date = new Date(this.date.getTime() + ms);
  }
}
