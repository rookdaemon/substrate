import http from "node:http";
import { LoopHttpServer } from "../../src/loop/LoopHttpServer";
import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { LoopState } from "../../src/loop/types";
import { SubstrateMeta } from "../../src/substrate/MetaManager";

const mockOrchestrator = {
  getState: () => LoopState.STOPPED,
  getMetrics: () => ({}),
  getRateLimitUntil: () => null,
  getPendingMessageCount: () => 0,
} as unknown as LoopOrchestrator;

function makeRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 500, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("LoopHttpServer - State Endpoint", () => {
  let server: LoopHttpServer;

  beforeEach(() => {
    server = new LoopHttpServer();
    server.setOrchestrator(mockOrchestrator);
  });

  afterEach(() => {
    server.close();
  });

  it("should return state when meta is set", async () => {
    const meta: SubstrateMeta = {
      name: "testAgent",
      fullName: "Test Agent",
      birthdate: "2026-01-01T00:00:00.000Z",
    };
    server.setMeta(meta);
    server.setMode("cycle");

    const port = await server.listen(0);
    const token = process.env.API_TOKEN || "test-token";
    const resp = await makeRequest(port, "GET", "/api/state", { Authorization: `Bearer ${token}` });

    expect(resp.statusCode).toBe(200);
    const data = JSON.parse(resp.body);
    expect(data.agentName).toBe("testAgent");
    expect(data.mode).toBe("cycle");
    expect(data.initialized).toBe(true);
  });

  it("should return initialized=false when meta is not set", async () => {
    server.setMode("tick");

    const port = await server.listen(0);
    const token = process.env.API_TOKEN || "test-token";
    const resp = await makeRequest(port, "GET", "/api/state", { Authorization: `Bearer ${token}` });

    expect(resp.statusCode).toBe(200);
    const data = JSON.parse(resp.body);
    expect(data.agentName).toBeUndefined();
    expect(data.mode).toBe("tick");
    expect(data.initialized).toBe(false);
  });

  it("should require authentication", async () => {
    const port = await server.listen(0);
    const resp = await makeRequest(port, "GET", "/api/state");

    expect(resp.statusCode).toBe(401);
    const data = JSON.parse(resp.body);
    expect(data.error).toBe("Unauthorized");
  });
});
