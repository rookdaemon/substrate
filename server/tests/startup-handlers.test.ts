import { InMemoryFileSystem } from "../src/substrate/abstractions/InMemoryFileSystem";
import { startServer } from "../src/startup";
import type { AppConfig } from "../src/config";

// Mock createApplication so startServer doesn't need a real Claude setup
jest.mock("../src/loop/createApplication", () => ({
  createApplication: jest.fn(),
}));

// Mock NodeFileSystem so startServer uses an in-memory FS for PID + substrate ops
jest.mock("../src/substrate/abstractions/NodeFileSystem", () => ({
  NodeFileSystem: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApplication } = require("../src/loop/createApplication") as {
  createApplication: jest.Mock;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { NodeFileSystem } = require("../src/substrate/abstractions/NodeFileSystem") as {
  NodeFileSystem: jest.Mock;
};

const makeConfig = (overrides?: Partial<AppConfig>): AppConfig => ({
  substratePath: "/substrate",
  workingDirectory: "/",
  sourceCodePath: "/src",
  backupPath: "/backup",
  port: 3000,
  model: "sonnet",
  mode: "cycle",
  autoStartOnFirstRun: false,
  autoStartAfterRestart: false,
  // Use a very short grace period so tests don't hang
  shutdownGraceMs: 50,
  ...overrides,
});

/** Flush the microtask queue so promise chains settle. */
const flushPromises = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe("startServer — process error handlers", () => {
  let mockApp: { stop: jest.Mock; start: jest.Mock; logPath: string };
  let mockExit: jest.SpyInstance;
  // Listeners that existed before each test — restored in afterEach
  let preRejectionListeners: NodeJS.UnhandledRejectionListener[];
  let preExceptionListeners: NodeJS.UncaughtExceptionListener[];

  beforeEach(async () => {
    // Capture pre-existing process listeners so we can restore them after each test
    preRejectionListeners = process.rawListeners(
      "unhandledRejection"
    ) as NodeJS.UnhandledRejectionListener[];
    preExceptionListeners = process.rawListeners(
      "uncaughtException"
    ) as NodeJS.UncaughtExceptionListener[];

    // Build mock app
    mockApp = {
      stop: jest.fn().mockResolvedValue(undefined),
      start: jest.fn().mockResolvedValue(3000),
      logPath: "/debug.log",
    };
    createApplication.mockResolvedValue(mockApp);

    // Each call to `new NodeFileSystem()` returns a fresh in-memory FS
    NodeFileSystem.mockImplementation(() => new InMemoryFileSystem());

    // Prevent actual process termination during tests
    mockExit = jest.spyOn(process, "exit").mockImplementation((() => {
      /* no-op */
    }) as never);
  });

  afterEach(() => {
    mockExit.mockRestore();
    jest.clearAllMocks();

    // Remove any handlers that startServer added and restore pre-existing ones
    process.removeAllListeners("unhandledRejection");
    preRejectionListeners.forEach((l) =>
      process.on("unhandledRejection", l)
    );

    process.removeAllListeners("uncaughtException");
    preExceptionListeners.forEach((l) =>
      process.on("uncaughtException", l)
    );
  });

  it("registers unhandledRejection handler during startServer", async () => {
    const listenersBefore = process.listenerCount("unhandledRejection");

    await startServer(makeConfig());

    expect(process.listenerCount("unhandledRejection")).toBe(listenersBefore + 1);
  });

  it("registers uncaughtException handler during startServer", async () => {
    const listenersBefore = process.listenerCount("uncaughtException");

    await startServer(makeConfig());

    expect(process.listenerCount("uncaughtException")).toBe(listenersBefore + 1);
  });

  it("unhandledRejection handler calls app.stop() before process.exit(1)", async () => {
    await startServer(makeConfig());

    const rejection = Promise.reject(new Error("unhandled"));
    rejection.catch(() => {}); // suppress secondary unhandledRejection event

    process.emit("unhandledRejection", new Error("unhandled"), rejection);

    await flushPromises();

    expect(mockApp.stop).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("uncaughtException handler calls app.stop() before process.exit(1)", async () => {
    await startServer(makeConfig());

    process.emit("uncaughtException", new Error("kaboom"), { promise: Promise.resolve(), reason: undefined });

    await flushPromises();

    expect(mockApp.stop).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("handler exits with 1 even when app is not yet initialised (appForCleanup is null)", async () => {
    // We need the handler to fire before createApplication resolves.
    // Simulate this by making createApplication hang until we manually emit the event.
    let resolveApp!: (app: typeof mockApp) => void;
    createApplication.mockReturnValue(
      new Promise<typeof mockApp>((resolve) => {
        resolveApp = resolve;
      })
    );

    // Start server but don't await — it will be stuck at createApplication
    const serverPromise = startServer(makeConfig());

    // Give startServer time to register the handlers (they are registered before createApplication)
    await flushPromises();

    // Emit before createApplication resolves — appForCleanup is still null
    process.emit("unhandledRejection", new Error("early rejection"), Promise.resolve());

    await flushPromises();

    // stop() was NOT called (app not yet created), but exit(1) was still triggered
    expect(mockApp.stop).not.toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(1);

    // Clean up the hanging promise
    resolveApp(mockApp);
    await serverPromise.catch(() => {});
  });

  it("handler falls back to timeout when app.stop() hangs", async () => {
    // stop() never resolves
    mockApp.stop.mockReturnValue(new Promise(() => {}));
    createApplication.mockResolvedValue(mockApp);

    await startServer(makeConfig({ shutdownGraceMs: 50 }));

    process.emit("unhandledRejection", new Error("hang"), Promise.resolve());

    // Wait longer than the grace period for the timeout branch to fire
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(mockApp.stop).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
