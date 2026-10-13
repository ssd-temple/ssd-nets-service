const environment = {
  port: "<<DEV_COGNITO_USER_POOL_CLIENT_ID>>",
};

const env = process.env;

beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  process.env = env;
});

module.exports = {
  environment,
};
