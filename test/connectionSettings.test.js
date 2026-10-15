const { applyConnectionSettings, DEFAULT_UPDATE_REPO } = require('../source/configPath');

describe('backend connection settings', () => {
  test('saves the trimmed Cloud URL and callback secret', () => {
    const out = applyConnectionSettings({ cloud_url: ' https://uatapi.example.com ', callbackSecret: ' s3cret ' });
    expect(out.cloud_url).toBe('https://uatapi.example.com');
    expect(out.callbackSecret).toBe('s3cret');
  });

  test('a blank callback secret is left out so the saved one is kept', () => {
    const out = applyConnectionSettings({ cloud_url: 'https://api.example.com', callbackSecret: '' });
    expect('callbackSecret' in out).toBe(false);
    expect(out.cloud_url).toBe('https://api.example.com');
  });

  test('the Cloud URL can be cleared', () => {
    expect(applyConnectionSettings({ cloud_url: '' }).cloud_url).toBe('');
  });

  test('leftover UAT/Production profile keys are cleared so no stale secret copy stays on disk', () => {
    const out = applyConnectionSettings({ cloud_url: 'https://x' });
    expect('environments' in out).toBe(true);
    expect(out.environments).toBeUndefined();
    const written = JSON.parse(JSON.stringify({ environments: { uat: { callbackSecret: 'old' } }, ...out }));
    expect(written.environments).toBeUndefined();
    expect(written.activeEnvironment).toBeUndefined();
  });

  test('the update repo defaults to the SSD Nets-Service repo', () => {
    expect(DEFAULT_UPDATE_REPO).toBe('https://github.com/ssd-temple/ssd-nets-service');
  });
});
