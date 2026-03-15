import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgoraStateStore } from "../../src/agora/AgoraStateStore";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { NodeFileSystem } from "../../src/substrate/abstractions/NodeFileSystem";

describe("AgoraStateStore", () => {
  const STATE_PATH = "/fake/.agora_state.json";
  let fs: InMemoryFileSystem;
  let store: AgoraStateStore;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    store = new AgoraStateStore(STATE_PATH, fs);
  });

  describe("load()", () => {
    it("returns empty lastSeen when state file is absent", async () => {
      const state = await store.load();
      expect(state).toEqual({ lastSeen: {} });
    });

    it("returns parsed state when file exists", async () => {
      await fs.writeFile(STATE_PATH, JSON.stringify({ lastSeen: { "pubkey1": 1000 } }));
      const state = await store.load();
      expect(state.lastSeen["pubkey1"]).toBe(1000);
    });

    it("returns empty lastSeen when file is malformed JSON", async () => {
      await fs.writeFile(STATE_PATH, "not-json{{");
      const state = await store.load();
      expect(state).toEqual({ lastSeen: {} });
    });

    it("returns empty lastSeen when lastSeen field is missing", async () => {
      await fs.writeFile(STATE_PATH, JSON.stringify({ other: "data" }));
      const state = await store.load();
      expect(state).toEqual({ lastSeen: {} });
    });
  });

  describe("save()", () => {
    it("writes state as formatted JSON", async () => {
      await store.save({ lastSeen: { "pk1": 5000, "pk2": 6000 } });
      const content = await fs.readFile(STATE_PATH);
      const parsed = JSON.parse(content);
      expect(parsed.lastSeen).toEqual({ "pk1": 5000, "pk2": 6000 });
    });
  });

  describe("updateLastSeen()", () => {
    it("creates a new entry when none exists", async () => {
      await store.updateLastSeen("pubkeyA", 1000);
      const val = await store.getLastSeen("pubkeyA");
      expect(val).toBe(1000);
    });

    it("updates lastSeen when newer timestamp provided", async () => {
      await store.updateLastSeen("pubkeyA", 1000);
      await store.updateLastSeen("pubkeyA", 2000);
      const val = await store.getLastSeen("pubkeyA");
      expect(val).toBe(2000);
    });

    it("does NOT overwrite with older timestamp", async () => {
      await store.updateLastSeen("pubkeyA", 2000);
      await store.updateLastSeen("pubkeyA", 1000); // older — should be ignored
      const val = await store.getLastSeen("pubkeyA");
      expect(val).toBe(2000);
    });

    it("handles multiple peers independently", async () => {
      await store.updateLastSeen("peerA", 1000);
      await store.updateLastSeen("peerB", 9000);
      expect(await store.getLastSeen("peerA")).toBe(1000);
      expect(await store.getLastSeen("peerB")).toBe(9000);
    });

    it("is resilient to write failures (does not throw)", async () => {
      const brokenFs = new InMemoryFileSystem();
      jest.spyOn(brokenFs, "writeFile").mockRejectedValue(new Error("disk full"));
      const brokenStore = new AgoraStateStore(STATE_PATH, brokenFs);
      // Should not throw
      await expect(brokenStore.updateLastSeen("pk", 1000)).resolves.not.toThrow();
    });
  });

  describe("getLastSeen()", () => {
    it("returns undefined for unknown peer", async () => {
      expect(await store.getLastSeen("unknown")).toBeUndefined();
    });

    it("returns the stored timestamp for known peer", async () => {
      await fs.writeFile(STATE_PATH, JSON.stringify({ lastSeen: { "knownPeer": 42000 } }));
      expect(await store.getLastSeen("knownPeer")).toBe(42000);
    });
  });

  describe("getLastSeenAll()", () => {
    it("returns empty object when no peers", async () => {
      expect(await store.getLastSeenAll()).toEqual({});
    });

    it("returns all stored peers", async () => {
      await fs.writeFile(STATE_PATH, JSON.stringify({ lastSeen: { "a": 1, "b": 2 } }));
      expect(await store.getLastSeenAll()).toEqual({ "a": 1, "b": 2 });
    });
  });

  describe("real filesystem (integration)", () => {
    let tmpDir: string;
    let realStore: AgoraStateStore;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "agora-state-test-"));
      realStore = new AgoraStateStore(join(tmpDir, ".agora_state.json"), new NodeFileSystem());
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("persists and reloads lastSeen across store instances", async () => {
      await realStore.updateLastSeen("peerX", 99999);
      const store2 = new AgoraStateStore(join(tmpDir, ".agora_state.json"), new NodeFileSystem());
      expect(await store2.getLastSeen("peerX")).toBe(99999);
    });
  });
});
