'use strict';

const { validateImportBuffer } = require('../src/main/file-validator');

// ── Helpers ──────────────────────────────────────────────────────────────────

function buf(str)   { return Buffer.from(str, 'utf8'); }
function bufHex(h)  { return Buffer.from(h, 'hex'); }

// ── Generic checks (apply to both types) ─────────────────────────────────────

describe('validateImportBuffer — generic', () => {
  it('rejects an empty buffer', () => {
    const r = validateImportBuffer(Buffer.alloc(0), 'script');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/empty/i);
  });

  it('rejects a buffer that exceeds the size limit', () => {
    const big = Buffer.alloc(512 * 1024 + 1, 'a');
    const r   = validateImportBuffer(big, 'script');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too large/i);
    expect(r.error).toMatch(/512/);
  });

  it('accepts a buffer right at the size limit', () => {
    // 512 KB of valid script content
    const content = '#!/bin/bash\n' + 'echo hello\n'.repeat((512 * 1024) / 11 - 2);
    const r = validateImportBuffer(buf(content.slice(0, 512 * 1024)), 'script');
    expect(r.ok).toBe(true);
  });

  it('rejects binary files (null bytes)', () => {
    const binary = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x00, 0x6f]); // "Hell\0o"
    const r = validateImportBuffer(binary, 'script');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/binary/i);
  });

  it('rejects invalid UTF-8 sequences', () => {
    // 0xff is not valid in UTF-8
    const invalid = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff]);
    const r = validateImportBuffer(invalid, 'script');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/UTF-8/i);
  });

  it('rejects files with lines longer than 10 000 chars', () => {
    const longLine = 'x'.repeat(10001);
    const r = validateImportBuffer(buf(longLine), 'script');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/long lines/i);
  });

  it('accepts a file with lines just at the 10 000 char limit', () => {
    const line = '#!/bin/bash\n' + 'x'.repeat(10000);
    const r = validateImportBuffer(buf(line), 'script');
    expect(r.ok).toBe(true);
  });
});

// ── Script-type validation ────────────────────────────────────────────────────

describe('validateImportBuffer — script', () => {
  it('accepts a file with a shebang line', () => {
    const r = validateImportBuffer(buf('#!/bin/bash\necho "hello"\n'), 'script');
    expect(r.ok).toBe(true);
    expect(r.content).toContain('echo');
  });

  it('accepts a file with aws CLI keyword (no shebang)', () => {
    const r = validateImportBuffer(buf('aws s3 ls\n'), 'script');
    expect(r.ok).toBe(true);
  });

  it('accepts a file with python keyword', () => {
    const r = validateImportBuffer(buf('import boto3\nprint("hi")\n'), 'script');
    expect(r.ok).toBe(true);
  });

  it('accepts a file with function keyword', () => {
    const r = validateImportBuffer(buf('function deploy() { echo done; }\n'), 'script');
    expect(r.ok).toBe(true);
  });

  it('rejects whitespace-only content', () => {
    const r = validateImportBuffer(buf('   \n\t\n  \n'), 'script');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no usable content/i);
  });

  it('rejects content with no shebang and no recognised keywords', () => {
    const r = validateImportBuffer(buf('Hello world\nThis is a text file.\n'), 'script');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not appear to be a script/i);
  });

  it('returns content string on success', () => {
    const r = validateImportBuffer(buf('#!/usr/bin/env python3\nprint("ok")\n'), 'script');
    expect(r.ok).toBe(true);
    expect(typeof r.content).toBe('string');
    expect(r.content).toContain('print');
  });
});

// ── CFN-type validation ───────────────────────────────────────────────────────

describe('validateImportBuffer — cfn', () => {
  it('accepts valid CFN YAML with AWSTemplateFormatVersion', () => {
    const yaml = 'AWSTemplateFormatVersion: "2010-09-09"\nResources:\n  MyBucket:\n    Type: AWS::S3::Bucket\n';
    const r = validateImportBuffer(buf(yaml), 'cfn');
    expect(r.ok).toBe(true);
  });

  it('accepts valid CFN YAML with only Resources key', () => {
    const yaml = 'Resources:\n  MyBucket:\n    Type: AWS::S3::Bucket\n';
    const r = validateImportBuffer(buf(yaml), 'cfn');
    expect(r.ok).toBe(true);
  });

  it('accepts valid CFN JSON', () => {
    const json = JSON.stringify({
      AWSTemplateFormatVersion: '2010-09-09',
      Resources: { MyBucket: { Type: 'AWS::S3::Bucket' } },
    });
    const r = validateImportBuffer(buf(json), 'cfn');
    expect(r.ok).toBe(true);
  });

  it('rejects malformed JSON', () => {
    const r = validateImportBuffer(buf('{ "AWSTemplateFormatVersion": "2010-09-09", bad }'), 'cfn');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not valid JSON/i);
  });

  it('rejects a plain text file with no CFN keys', () => {
    const r = validateImportBuffer(buf('Hello, this is not a template.\nJust some text.\n'), 'cfn');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not appear to be a CloudFormation template/i);
  });

  it('rejects a shell script when type is cfn', () => {
    const r = validateImportBuffer(buf('#!/bin/bash\necho "hello"\n'), 'cfn');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/CloudFormation template/i);
  });

  it('accepts a CFN template with Description key', () => {
    const yaml = 'Description: My stack\nResources:\n  R:\n    Type: AWS::S3::Bucket\n';
    const r = validateImportBuffer(buf(yaml), 'cfn');
    expect(r.ok).toBe(true);
  });

  it('accepts a CFN template with Parameters key', () => {
    const yaml = 'Parameters:\n  Env:\n    Type: String\nResources:\n  R:\n    Type: AWS::S3::Bucket\n';
    const r = validateImportBuffer(buf(yaml), 'cfn');
    expect(r.ok).toBe(true);
  });
});
