const { applyEnvironmentSettings, describeEnvironments, DEFAULT_UPDATE_REPO } = require('../source/configPath');

describe('environment profiles', () => {
  test('saving a profile makes it active and mirrors it to the flat keys', () => {
    const out = applyEnvironmentSettings({}, 'uat', {
      cloud_url: ' https://api-uat.example.com ',
      callbackSecret: 'secret-uat',
    });
    expect(out.activeEnvironment).toBe('uat');
    expect(out.cloud_url).toBe('https://api-uat.example.com');
    expect(out.callbackSecret).toBe('secret-uat');
    expect(out.environments.uat).toEqual({ cloud_url: 'https://api-uat.example.com', callbackSecret: 'secret-uat' });
  });

  test('a profile holds only the Cloud URL and the secret', () => {
    const out = applyEnvironmentSettings({}, 'uat', {
      cloud_url: 'https://uat',
      callbackSecret: 'a',
      updateRepo: 'https://github.com/o/r',
      githubToken: 'tok',
    });
    expect(Object.keys(out.environments.uat).sort()).toEqual(['callbackSecret', 'cloud_url']);
    expect(out.updateRepo).toBeUndefined();
    expect(out.githubToken).toBeUndefined();
  });

  test('the other environment is left untouched', () => {
    const first = applyEnvironmentSettings({}, 'uat', { cloud_url: 'https://uat', callbackSecret: 'a' });
    const second = applyEnvironmentSettings(first, 'production', { cloud_url: 'https://prod', callbackSecret: 'b' });
    expect(second.environments.uat).toEqual(first.environments.uat);
    expect(second.cloud_url).toBe('https://prod');
    expect(second.callbackSecret).toBe('b');
  });

  test('a blank callback secret keeps the saved one; the Cloud URL can be cleared', () => {
    const saved = applyEnvironmentSettings({}, 'production', { cloud_url: 'https://prod', callbackSecret: 'keep-me' });
    const again = applyEnvironmentSettings(saved, 'production', { cloud_url: '', callbackSecret: '' });
    expect(again.callbackSecret).toBe('keep-me');
    expect(again.cloud_url).toBe('');
  });

  test('rejects an unknown environment', () => {
    expect(() => applyEnvironmentSettings({}, 'staging', {})).toThrow(/Unknown environment/);
  });

  test('describeEnvironments never exposes the secret', () => {
    const cfg = applyEnvironmentSettings({}, 'uat', { cloud_url: 'https://uat', callbackSecret: 'super-secret' });
    const described = describeEnvironments(cfg);
    expect(described.uat).toEqual({ cloud_url: 'https://uat', hasCallbackSecret: true });
    expect(described.production).toEqual({ cloud_url: '', hasCallbackSecret: false });
    expect(JSON.stringify(described)).not.toContain('super-secret');
  });

  test('the shared update repo defaults to the SSD Nets-Service repo', () => {
    expect(DEFAULT_UPDATE_REPO).toBe('https://github.com/ssd-temple/ssd-nets-service');
  });
});
