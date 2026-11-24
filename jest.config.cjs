// Scope jest to the cross-runner integration tests only (the src/*.test.ts
// suites are node:test). vigiles is an ES module package; Jest loads it through
// the `require` targets in package.json `exports` (scripts/build-cjs.mjs), the
// same way a user's Jest does, so no transform is needed.
module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/runners/**/*.jest.cjs"],
  transform: {},
  // Load the opt-in entry the way a user would — this also tests that
  // `vigiles/jest` registers the matchers (auto-register).
  setupFilesAfterEnv: ["vigiles/jest"],
};
