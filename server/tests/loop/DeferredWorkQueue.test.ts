import { DeferredWorkQueue } from "../../src/loop/DeferredWorkQueue";

describe("DeferredWorkQueue", () => {
  let queue: DeferredWorkQueue;

  beforeEach(() => {
    queue = new DeferredWorkQueue();
  });

  it("drain resolves immediately when queue is empty", async () => {
    await queue.drain(); // should not throw or hang
  });

  it("drain waits for all enqueued work to complete", async () => {
    const order: string[] = [];

    queue.enqueue(
      (async () => {
        await delay(10);
        order.push("a");
      })()
    );
    queue.enqueue(
      (async () => {
        await delay(20);
        order.push("b");
      })()
    );

    await queue.drain();
    expect(order).toEqual(["a", "b"]);
  });

  it("drain clears the queue so subsequent drain is a no-op", async () => {
    let count = 0;
    queue.enqueue(
      (async () => {
        count++;
      })()
    );

    await queue.drain();
    expect(count).toBe(1);

    // Second drain should not re-run anything
    await queue.drain();
    expect(count).toBe(1);
  });

  it("collects errors from failed work without rejecting drain", async () => {
    const errors: Error[] = [];
    const errorHandler = (err: Error) => errors.push(err);
    queue = new DeferredWorkQueue(errorHandler);

    queue.enqueue(Promise.reject(new Error("boom")));
    queue.enqueue(Promise.resolve());

    await queue.drain(); // should not throw
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("boom");
  });

  it("passes label to error handler when work fails", async () => {
    const calls: { message: string; label: string | undefined }[] = [];
    const errorHandler = (err: Error, label?: string) => calls.push({ message: err.message, label });
    queue = new DeferredWorkQueue(errorHandler);

    queue.enqueue(Promise.reject(new Error("labeled-fail")), "proposal_evaluation");
    queue.enqueue(Promise.reject(new Error("unlabeled-fail")));

    await queue.drain();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ message: "labeled-fail", label: "proposal_evaluation" });
    expect(calls[1]).toEqual({ message: "unlabeled-fail", label: undefined });
  });

  it("without error handler, drain still does not reject", async () => {
    queue.enqueue(Promise.reject(new Error("ignored")));
    await queue.drain(); // should not throw
  });

  it("work enqueued after drain starts is picked up by next drain", async () => {
    const order: string[] = [];

    queue.enqueue(
      (async () => {
        order.push("first");
      })()
    );

    await queue.drain();
    expect(order).toEqual(["first"]);

    queue.enqueue(
      (async () => {
        order.push("second");
      })()
    );

    await queue.drain();
    expect(order).toEqual(["first", "second"]);
  });

  it("reports pending count", () => {
    expect(queue.size).toBe(0);

    const neverResolve = new Promise<void>(() => {});
    queue.enqueue(neverResolve);
    expect(queue.size).toBe(1);

    queue.enqueue(neverResolve);
    expect(queue.size).toBe(2);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
