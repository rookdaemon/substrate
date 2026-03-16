import * as path from "path";
import { IFileSystem } from "../abstractions/IFileSystem";
import { IClock } from "../abstractions/IClock";
import { ICycleLogWriter } from "./ICycleLogWriter";

/**
 * Appends cycle-execution output (EGO narration, task summaries) to
 * `<substratePath>/cycle_log.md` with the format:
 *
 *   [YYYY-MM-DDTHH:mm:ssZ] [ROLE] <text>
 *
 * This file is append-only and never compacted, so CONVERSATION.md stays
 * clean (D-01 fix).
 */
export class CycleLogWriter implements ICycleLogWriter {
  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    private readonly substratePath: string,
    private readonly fileName: string = "cycle_log.md",
  ) {}

  async write(role: string, text: string): Promise<void> {
    const timestamp = this.clock.now().toISOString();
    const entry = `[${timestamp}] [${role}] ${text}\n`;
    const filePath = path.join(this.substratePath, this.fileName);
    await this.fs.appendFile(filePath, entry);
  }
}
