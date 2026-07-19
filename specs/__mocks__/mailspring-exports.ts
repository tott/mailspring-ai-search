// Minimal Mailspring API stubs for unit tests
export const DatabaseStore = {};
export const Message = { attributes: { body: {}, draft: { equal: () => ({}) }, date: { ascending: () => ({}) } } };
export const Thread = {};
export const Actions = {};
export const ComponentRegistry = { register: jest.fn(), unregister: jest.fn() };
export const AppEnv = {
  config: { get: jest.fn(), set: jest.fn(), onDidChange: jest.fn(() => ({ dispose: jest.fn() })) },
  isDevMode: jest.fn(() => false),
  reportError: jest.fn(),
};
