import { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  testPathIgnorePatterns: ["<rootDir>/dist"],
  setupFilesAfterEnv: ["jest-expect-message"],
  testTimeout: 2 * 60 * 1000,
  openHandlesTimeout: 5 * 1000,
};

export default config;
