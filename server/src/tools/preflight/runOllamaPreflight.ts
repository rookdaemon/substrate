#!/usr/bin/env node
/**
 * CLI entry point for the Ollama preflight check.
 *
 * Usage:
 *   npm run preflight:ollama
 *   npm run preflight:ollama -- --url http://nova-host:11434 --model phi4:14b
 *
 * Exit codes:
 *   0 = all tests pass
 *   1 = one or more critical failures
 *   2 = warnings only (all critical tests pass)
 */

import { FetchHttpClient } from "../../agents/ollama/FetchHttpClient";
import { OllamaPreflight } from "./OllamaPreflight";

const DEFAULT_URL = "http://localhost:11434";
const DEFAULT_MODEL = "qwen3:14b";

function parseArgs(argv: string[]): { url: string; model: string } {
  let url = DEFAULT_URL;
  let model = DEFAULT_MODEL;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1]) {
      url = argv[i + 1];
      i++;
    } else if (argv[i] === "--model" && argv[i + 1]) {
      model = argv[i + 1];
      i++;
    }
  }

  return { url: url.replace(/\/$/, ""), model };
}

async function main(): Promise<void> {
  const { url, model } = parseArgs(process.argv.slice(2));

  console.log(`Ollama Preflight — target: ${url}, model: ${model}\n`);

  const httpClient = new FetchHttpClient();
  const preflight = new OllamaPreflight(httpClient, url, model);

  const report = await preflight.run();
  console.log(OllamaPreflight.formatReport(report));

  if (!report.passed) {
    process.exit(1);
  } else if (report.warnCount > 0) {
    process.exit(2);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Preflight crashed:", err);
  process.exit(1);
});
