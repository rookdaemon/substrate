import { ScreenerInput, ScreenerResult } from "./types";

export interface IEndorsementScreener {
  evaluate(input: ScreenerInput): Promise<ScreenerResult>;
}
