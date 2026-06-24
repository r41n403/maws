'use strict';

/**
 * Validates an imported file (script or CFN template) from a raw Buffer.
 *
 * All validation runs in the main process and cannot be bypassed by the renderer.
 * Returns { ok: true, content } on success or { ok: false, error } on failure.
 *
 * @param {Buffer}  buffer  Raw file buffer (already size-checked by the caller)
 * @param {string}  type    'script' | 'cfn'
 * @param {number}  [maxBytes=524288]  Size limit in bytes (default 512 KB)
 */
function validateImportBuffer(buffer, type, maxBytes = 512 * 1024) {
  // ── 1. Size ───────────────────────────────────────────────────────────────
  if (buffer.length === 0) return { ok: false, error: 'File is empty.' };
  if (buffer.length > maxBytes) {
    const kb    = (buffer.length / 1024).toFixed(1);
    const maxKb = (maxBytes      / 1024).toFixed(0);
    return { ok: false, error: `File is too large (${kb} KB). Maximum allowed size is ${maxKb} KB.` };
  }

  // ── 2. Binary detection — reject null bytes ───────────────────────────────
  if (buffer.includes(0x00)) {
    return { ok: false, error: 'File appears to be binary. Only plain-text files are supported.' };
  }

  // ── 3. Encoding — must be valid UTF-8 ────────────────────────────────────
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return { ok: false, error: 'File is not valid UTF-8. Only UTF-8 encoded text files are supported.' };
  }

  // ── 4. Line-length sanity check (minified/obfuscated files) ──────────────
  const maxLine = content.split('\n').reduce((m, l) => Math.max(m, l.length), 0);
  if (maxLine > 10000) {
    return { ok: false, error: 'File contains extremely long lines (>10 000 chars). This does not look like a script or template.' };
  }

  // ── 5. Type-specific structural validation ────────────────────────────────
  if (type === 'script') {
    if (!/\S/.test(content)) {
      return { ok: false, error: 'File contains no usable content.' };
    }
    const hasShebang  = content.startsWith('#!');
    const hasKeywords = /\b(aws|echo|export|import|def |function |if |for |while |curl|python|bash|sh\b)/i.test(content.slice(0, 2000));
    if (!hasShebang && !hasKeywords) {
      return { ok: false, error: 'File does not appear to be a script (no shebang line or recognisable script keywords found). If this is intentional, rename the file to a recognised script extension and try again.' };
    }
  }

  if (type === 'cfn') {
    const trimmed        = content.trimStart();
    const looksLikeJson  = trimmed.startsWith('{');
    const cfnKeys        = /^(AWSTemplateFormatVersion|Description|Metadata|Parameters|Mappings|Conditions|Transform|Resources|Outputs)\s*[:\s]/m;
    const looksLikeYaml  = cfnKeys.test(trimmed);
    if (!looksLikeJson && !looksLikeYaml) {
      return { ok: false, error: 'File does not appear to be a CloudFormation template. Expected YAML or JSON containing standard CFN keys (AWSTemplateFormatVersion, Resources, etc.).' };
    }
    if (looksLikeJson) {
      try { JSON.parse(content); } catch (e) {
        return { ok: false, error: `File is not valid JSON: ${e.message}` };
      }
    }
  }

  return { ok: true, content };
}

module.exports = { validateImportBuffer };
