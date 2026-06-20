'use strict';

// Hoist-safe: jest.mock factories must be self-contained — no external variable refs.
jest.mock('keytar', () => ({
  getPassword:    jest.fn(() => Promise.resolve(null)),
  setPassword:    jest.fn(() => Promise.resolve()),
  deletePassword: jest.fn(() => Promise.resolve()),
}), { virtual: true });

jest.mock('fs', () => ({
  existsSync:    jest.fn(() => false),
  readFileSync:  jest.fn(() => ''),
  writeFileSync: jest.fn(),
  appendFileSync:jest.fn(),
  mkdirSync:     jest.fn(),
  unlinkSync:    jest.fn(),
  statSync:      jest.fn(() => ({ size: 0 })),
}));

jest.mock('ini', () => ({ parse: jest.fn(() => ({})) }), { virtual: true });

const fs = require('fs');
const { createAccessKeyProfile, createSSOProfile } = require('../src/main/aws-auth');

beforeEach(() => jest.clearAllMocks());

// ── createAccessKeyProfile ────────────────────────────────────────────────────

describe('createAccessKeyProfile', () => {
  it('rejects missing required fields', () => {
    const r = createAccessKeyProfile({ profileName: '', accessKeyId: '', secretAccessKey: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/required/i);
  });

  it('rejects an invalid access key format', () => {
    const r = createAccessKeyProfile({
      profileName:     'test',
      accessKeyId:     'notankey',
      secretAccessKey: 'secret',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid/i);
  });

  it('accepts a valid AKIA key', () => {
    const r = createAccessKeyProfile({
      profileName:     'test',
      accessKeyId:     'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    expect(r.ok).toBe(true);
    expect(r.profileName).toBe('test');
  });

  it('accepts a valid ASIA (STS temporary) key', () => {
    const r = createAccessKeyProfile({
      profileName:     'sts-test',
      accessKeyId:     'ASIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'some-secret-key',
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a duplicate profile name', () => {
    // Simulate credentials file that already has [existing-profile]
    fs.readFileSync.mockReturnValue('[existing-profile]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\n');
    const r = createAccessKeyProfile({
      profileName:     'existing-profile',
      accessKeyId:     'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'secret',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already exists/i);
  });
});

// ── createSSOProfile ──────────────────────────────────────────────────────────

describe('createSSOProfile', () => {
  it('rejects missing required fields', () => {
    const r = createSSOProfile({ profileName: '', ssoStartUrl: '', ssoRegion: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/required/i);
  });

  it('rejects a start URL without https://', () => {
    const r = createSSOProfile({
      profileName: 'test',
      ssoStartUrl: 'http://example.awsapps.com/start',
      ssoRegion:   'us-east-1',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/https/i);
  });

  it('accepts a valid SSO profile', () => {
    const r = createSSOProfile({
      profileName: 'my-company',
      ssoStartUrl: 'https://my-company.awsapps.com/start',
      ssoRegion:   'us-east-1',
    });
    expect(r.ok).toBe(true);
    expect(r.profileName).toBe('my-company');
  });

  it('rejects a duplicate profile name', () => {
    fs.readFileSync.mockReturnValue('[profile my-company]\nsso_session = my-company-sso\n');
    const r = createSSOProfile({
      profileName: 'my-company',
      ssoStartUrl: 'https://my-company.awsapps.com/start',
      ssoRegion:   'us-east-1',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already exists/i);
  });
});
