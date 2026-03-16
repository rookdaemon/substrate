import * as http from "node:http";
import { LoopHttpServer } from "../../src/loop/LoopHttpServer";
import { InMemoryEventSink } from "../../src/loop/InMemoryEventSink";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";

async function post(
  port: number,
  path: string,
  options: { authorization?: string } = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { "Content-Type": "application/json" };
    if (options.authorization !== undefined) {
      headers["Authorization"] = options.authorization;
    }
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("POST /hooks/agent bearer token auth", () => {
  let server: LoopHttpServer;
  let port: number;
  const clock = new FixedClock(new Date("2026-03-15T12:00:00.000Z"));

  afterEach(async () => {
    await server.close();
  });

  it("returns 401 when apiToken is configured and Authorization header is missing", async () => {
    server = new LoopHttpServer();
    server.setEventSink(new InMemoryEventSink(), clock);
    server.setApiToken("secret-token");
    port = await server.listen(0);

    const res = await post(port, "/hooks/agent");

    expect(res.status).toBe(401);
    expect((res.body as Record<string, unknown>).error).toBe("Unauthorized");
  });

  it("returns 401 when apiToken is configured and Authorization header has wrong token", async () => {
    server = new LoopHttpServer();
    server.setEventSink(new InMemoryEventSink(), clock);
    server.setApiToken("secret-token");
    port = await server.listen(0);

    const res = await post(port, "/hooks/agent", { authorization: "Bearer wrong-token" });

    expect(res.status).toBe(401);
    expect((res.body as Record<string, unknown>).error).toBe("Unauthorized");
  });

  it("passes auth and returns 503 when apiToken is configured and correct bearer token is provided", async () => {
    server = new LoopHttpServer();
    server.setEventSink(new InMemoryEventSink(), clock);
    server.setApiToken("secret-token");
    port = await server.listen(0);

    // 503 means auth passed but Agora is not configured — correct behaviour
    const res = await post(port, "/hooks/agent", { authorization: "Bearer secret-token" });

    expect(res.status).toBe(503);
  });

  it("succeeds without any Authorization header when apiToken is not configured", async () => {
    server = new LoopHttpServer();
    server.setEventSink(new InMemoryEventSink(), clock);
    port = await server.listen(0);

    // 503 means auth was not required and Agora is not configured — backward compatible
    const res = await post(port, "/hooks/agent");

    expect(res.status).toBe(503);
  });
});
