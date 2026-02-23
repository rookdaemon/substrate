import { LoopHttpServer } from "../../src/loop/LoopHttpServer";
import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { LoopState } from "../../src/loop/types";
import * as http from "http";

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

describe("LoopHttpServer auth", () => {
  let httpServer: LoopHttpServer;

  beforeEach(() => {
    httpServer = new LoopHttpServer();
    httpServer.setOrchestrator(mockOrchestrator);
  });

  afterEach(async () => {
    try { await httpServer.close(); } catch { /* already closed */ }
  });

  it("allows all requests when no apiToken is configured", async () => {
    const port = await httpServer.listen(0);
    const response = await makeRequest(port, "GET", "/api/loop/status");
    expect(response.statusCode).toBe(200);
  });

  it("returns 401 for /api/* when apiToken is set and no Authorization header", async () => {
    httpServer.setApiToken("secret-token");
    const port = await httpServer.listen(0);
    const response = await makeRequest(port, "GET", "/api/loop/status");
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: "Unauthorized" });
  });

  it("returns 200 for /api/* with correct Bearer token", async () => {
    httpServer.setApiToken("secret-token");
    const port = await httpServer.listen(0);
    const response = await makeRequest(port, "GET", "/api/loop/status", {
      Authorization: "Bearer secret-token",
    });
    expect(response.statusCode).toBe(200);
  });

  it("returns 401 with an incorrect Bearer token", async () => {
    httpServer.setApiToken("secret-token");
    const port = await httpServer.listen(0);
    const response = await makeRequest(port, "GET", "/api/loop/status", {
      Authorization: "Bearer wrong-token",
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 when Authorization header is present but not Bearer scheme", async () => {
    httpServer.setApiToken("secret-token");
    const port = await httpServer.listen(0);
    const response = await makeRequest(port, "GET", "/api/loop/status", {
      Authorization: "Basic secret-token",
    });
    expect(response.statusCode).toBe(401);
  });

  it("does not enforce apiToken on /hooks/* routes", async () => {
    httpServer.setApiToken("secret-token");
    const port = await httpServer.listen(0);
    // /hooks/agent without API token should reach the handler (returns 503, not 401)
    const response = await makeRequest(port, "POST", "/hooks/agent");
    expect(response.statusCode).toBe(503);
  });

  it("enforces apiToken on /hooks without trailing slash (not a hooks route)", async () => {
    httpServer.setApiToken("secret-token");
    const port = await httpServer.listen(0);
    // /hooks (no trailing slash) is not a valid hooks route — auth IS required
    const response = await makeRequest(port, "POST", "/hooks");
    expect(response.statusCode).toBe(401);
  });

  it("enforces apiToken on POST /api/loop/start", async () => {
    httpServer.setApiToken("my-token");
    const port = await httpServer.listen(0);
    const unauthResp = await makeRequest(port, "POST", "/api/loop/start");
    expect(unauthResp.statusCode).toBe(401);
    const authResp = await makeRequest(port, "POST", "/api/loop/start", {
      Authorization: "Bearer my-token",
    });
    // 200 or 409 depending on state — either way it passed auth
    expect(authResp.statusCode).not.toBe(401);
  });
});
