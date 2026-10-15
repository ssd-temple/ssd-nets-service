const { applyEnvironmentSettings, describeEnvironments, DEFAULT_UPDATE_REPO } = require('../source/configPath');

describe('environment profiles', () => {
  test('saving a profile makes it active and mirrors it to the flat keys', () => {
    const out = applyEnvironmentSettings({}, 'uat', {
      cloud_url: ' https://api-uat.example.com ',
      updateRepo: 'https://github.com/o/r',
      githubToken: 'tok',
      callbackSecret: 'secret-uat',
    });
    expect(out.activeEnvironment).toBe('uat');
    expect(out.cloud_url).toBe('https://api-uat.example.com');
    expect(out.callbackSecret).toBe('secret-uat');
    expect(out.environments.uat.updateRepo).toBe('https://github.com/o/r');
  });

  test('the other environment is left untouched', () => {
    const first = applyEnvironmentSettings({}, 'uat', { cloud_url: 'https://uat', callbackSecret: 'a' });
    const second = applyEnvironmentSettings(first, 'production', { cloud_url: 'https://prod', callbackSecret: 'b' });
    expect(second.environments.uat).toEqual(first.environments.uat);
    expect(second.cloud_url).toBe('https://prod');
    expect(second.callbackSecret).toBe('b');
  });

  test('a blank callback secret keeps the saved one; other fields can be cleared', () => {
    const saved = applyEnvironmentSettings({}, 'production', { cloud_url: 'https://prod', githubToken: 't', callbackSecret: 'keep-me' });
    const again = applyEnvironmentSettings(saved, 'production', { cloud_url: 'https://prod', githubToken: '', callbackSecret: '' });
    expect(again.callbackSecret).toBe('keep-me');
    expect(again.githubToken).toBe('');
  });

  test('rejects an unknown environment', () => {
    expect(() => applyEnvironmentSettings({}, 'staging', {})).toThrow(/Unknown environment/);
  });

  test('describeEnvironments never exposes the secret', () => {
    const cfg = applyEnvironmentSettings({}, 'uat', { cloud_url: 'https://uat', callbackSecret: 'super-secret' });
    const described = describeEnvironments(cfg);
    expect(described.uat.hasCallbackSecret).toBe(true);
    expect(described.production.hasCallbackSecret).toBe(false);
    expect(JSON.stringify(described)).not.toContain('super-secret');
  });

  test('the update repo defaults to the SSD Nets-Service repo when none is saved', () => {
    expect(DEFAULT_UPDATE_REPO).toBe('https://github.com/ssd-temple/ssd-nets-service');
    expect(describeEnvironments({}).uat.updateRepo).toBe(DEFAULT_UPDATE_REPO);
    expect(applyEnvironmentSettings({}, 'production', { cloud_url: 'https://prod' }).updateRepo).toBe(DEFAULT_UPDATE_REPO);
  });
});
