module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/specs/**/*.spec.ts'],
  moduleNameMapper: {
    // Mock Mailspring globals — not available outside Electron
    'mailspring-exports': '<rootDir>/specs/__mocks__/mailspring-exports.ts',
  },
};
