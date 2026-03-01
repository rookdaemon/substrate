import * as path from "path";
import { NodeFileSystem } from "../substrate/abstractions/NodeFileSystem";
import { SystemClock } from "../substrate/abstractions/SystemClock";
import { SubstrateConfig } from "../substrate/config";
import { SubstrateFileReader } from "../substrate/io/FileReader";
import { SubstrateFileWriter } from "../substrate/io/FileWriter";
import { AppendOnlyWriter } from "../substrate/io/AppendOnlyWriter";
import { FileLock } from "../substrate/io/FileLock";
import { FileLogger, type LogLevel } from "../logging";
import { SuperegoFindingTracker } from "../agents/roles/SuperegoFindingTracker";
import { MetaManager } from "../substrate/MetaManager";
import { GitVersionControl } from "../substrate/versioning/GitVersionControl";
import { NodeProcessRunner as NodeProcessRunnerV2 } from "../substrate/abstractions/NodeProcessRunner";

export interface SubstrateLayerResult {
  fs: NodeFileSystem;
  clock: SystemClock;
  substrateConfig: SubstrateConfig;
  reader: SubstrateFileReader;
  writer: SubstrateFileWriter;
  appendWriter: AppendOnlyWriter;
  lock: FileLock;
  logger: FileLogger;
  logPath: string;
  metaManager: MetaManager;
  findingTracker: SuperegoFindingTracker;
  findingTrackerSave: () => Promise<void>;
  git?: GitVersionControl;
}

/**
 * Creates and initialises all substrate-level I/O primitives:
 * filesystem, clock, config, readers/writers, logger, MetaManager
 * and the SuperegoFindingTracker.
 */
export async function createSubstrateLayer(
  substratePath: string,
  logLevel?: LogLevel,
  enableFileReadCache = true,
  progressMaxBytes?: number
): Promise<SubstrateLayerResult> {
  const fs = new NodeFileSystem();
  const clock = new SystemClock();
  const substrateConfig = new SubstrateConfig(substratePath);
  const reader = new SubstrateFileReader(fs, substrateConfig, enableFileReadCache);
  const lock = new FileLock();
  const writer = new SubstrateFileWriter(fs, substrateConfig, lock, reader);
  const appendWriter = new AppendOnlyWriter(fs, substrateConfig, lock, clock, reader, progressMaxBytes);

  // Meta — session identity (name, fullName, birthdate) stored in meta.json
  const metaManager = new MetaManager(fs, clock, substratePath);
  await metaManager.initialize();

  // Logger — created early so all layers can use it
  const logPath = path.resolve(substratePath, "..", "debug.log");
  const logger = new FileLogger(logPath, undefined, logLevel ?? "info");

  // Finding tracker — loaded from disk for durable escalation across restarts
  const trackerStatePath = path.resolve(substratePath, "..", ".superego-tracker.json");
  const findingTracker = await SuperegoFindingTracker.load(trackerStatePath, fs, logger);
  const findingTrackerSave = () => findingTracker.save(trackerStatePath, fs);


  // Initialize git version control (optional)
  let git: GitVersionControl | undefined;
  if (await fs.exists(path.join(substratePath, ".git"))) {
    const processRunner = new NodeProcessRunnerV2();
    git = new GitVersionControl(substratePath, processRunner, fs, logger);
    await git.initialize(); // Ensure git config is set
  }

  return {
    fs, clock, substrateConfig, reader, writer, appendWriter, lock,
    logger, logPath, metaManager, findingTracker, findingTrackerSave, git,
  };
}
