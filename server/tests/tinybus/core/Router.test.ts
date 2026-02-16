import { DefaultRouter } from "../../../src/tinybus/core/Router";
import { createMessage } from "../../../src/tinybus/core/Message";
import { MemoryProvider } from "../../../src/tinybus/providers/MemoryProvider";

describe("Router", () => {
  describe("DefaultRouter", () => {
    let router: DefaultRouter;
    let provider1: MemoryProvider;
    let provider2: MemoryProvider;
    let provider3: MemoryProvider;

    beforeEach(() => {
      router = new DefaultRouter();
      provider1 = new MemoryProvider("provider-1");
      provider2 = new MemoryProvider("provider-2");
      provider3 = new MemoryProvider("provider-3");
    });

    describe("direct routing", () => {
      it("routes to specific destination when destination is set", () => {
        const message = createMessage({
          type: "test.message",
          source: "provider-1",
          destination: "provider-2",
        });

        const targets = router.route(message, [
          provider1,
          provider2,
          provider3,
        ]);

        expect(targets).toHaveLength(1);
        expect(targets[0].id).toBe("provider-2");
      });

      it("returns empty array when destination not found", () => {
        const message = createMessage({
          type: "test.message",
          source: "provider-1",
          destination: "non-existent",
        });

        const targets = router.route(message, [
          provider1,
          provider2,
          provider3,
        ]);

        expect(targets).toHaveLength(0);
      });

      it("routes to destination even if it matches source", () => {
        const message = createMessage({
          type: "test.message",
          source: "provider-1",
          destination: "provider-1",
        });

        const targets = router.route(message, [
          provider1,
          provider2,
          provider3,
        ]);

        expect(targets).toHaveLength(1);
        expect(targets[0].id).toBe("provider-1");
      });
    });

    describe("broadcast routing", () => {
      it("routes to all providers except source when no destination", () => {
        const message = createMessage({
          type: "test.broadcast",
          source: "provider-1",
        });

        const targets = router.route(message, [
          provider1,
          provider2,
          provider3,
        ]);

        expect(targets).toHaveLength(2);
        expect(targets.map((t) => t.id)).toContain("provider-2");
        expect(targets.map((t) => t.id)).toContain("provider-3");
        expect(targets.map((t) => t.id)).not.toContain("provider-1");
      });

      it("routes to all providers when source is not set", () => {
        const message = createMessage({
          type: "test.broadcast",
        });

        const targets = router.route(message, [
          provider1,
          provider2,
          provider3,
        ]);

        expect(targets).toHaveLength(3);
      });

      it("returns empty array when only source provider exists", () => {
        const message = createMessage({
          type: "test.broadcast",
          source: "provider-1",
        });

        const targets = router.route(message, [provider1]);

        expect(targets).toHaveLength(0);
      });
    });
  });
});
