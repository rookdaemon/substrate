/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  collectCoverageFrom: ["src/**/*.ts"],
  moduleNameMapper: {
    "^@anthropic-ai/claude-agent-sdk$": "<rootDir>/tests/__mocks__/claude-agent-sdk.ts",
    "^@rookdaemon/agora$": "<rootDir>/tests/__mocks__/agora.ts",
  },
  globals: {
    "ts-jest": {
      tsconfig: {
        module: "commonjs",
        moduleResolution: "node",
      },
    },
  },
  forceExit: true,
  testTimeout: 4000,
};
