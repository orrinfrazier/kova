export interface CostAccumulatorOptions {
  onCostUpdate?: (total: number) => void;
}

export class CostAccumulator {
  private total = 0;
  private turns = 0;
  private duration = 0;
  private readonly onCostUpdate: ((total: number) => void) | undefined;

  constructor(options?: CostAccumulatorOptions) {
    this.onCostUpdate = options?.onCostUpdate;
  }

  add(amount: number): void {
    this.total += amount;
    this.onCostUpdate?.(this.total);
  }

  get(): number {
    return this.total;
  }

  get current(): number {
    return this.total;
  }

  exceedsBudget(budget: number): boolean {
    return this.total >= budget;
  }

  addTurns(count: number): void {
    this.turns += count;
  }

  getTurns(): number {
    return this.turns;
  }

  addDuration(ms: number): void {
    this.duration += ms;
  }

  getDuration(): number {
    return this.duration;
  }
}
