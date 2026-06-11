/**
 * P10 — unit tests for `rephraseUnknownOption`.
 *
 * Commander emits "error: unknown option '--foo'" when an unknown flag is
 * encountered. If `--foo` is a known global flag placed after a subcommand,
 * we rephrase the message to guide the user to move the flag before the
 * subcommand name.
 */
import { describe, expect, it } from 'vitest';
import { rephraseUnknownOption } from './render-error.js';

describe('rephraseUnknownOption', () => {
  it('rephrases --dry-run placed after subcommand', () => {
    const result = rephraseUnknownOption("error: unknown option '--dry-run'");
    expect(result).not.toBeNull();
    expect(result).toContain('--dry-run');
    expect(result).toContain('global flag');
    expect(result).toContain('before the subcommand');
  });

  it('rephrases --output placed after subcommand', () => {
    const result = rephraseUnknownOption("error: unknown option '--output'");
    expect(result).not.toBeNull();
    expect(result).toContain('--output');
    expect(result).toContain('Example:');
  });

  it('rephrases --profile placed after subcommand', () => {
    const result = rephraseUnknownOption("error: unknown option '--profile'");
    expect(result).not.toBeNull();
    expect(result).toContain('--profile');
  });

  it('rephrases --endpoint-url placed after subcommand', () => {
    const result = rephraseUnknownOption("error: unknown option '--endpoint-url'");
    expect(result).not.toBeNull();
    expect(result).toContain('--endpoint-url');
  });

  it('rephrases --debug placed after subcommand', () => {
    const result = rephraseUnknownOption("error: unknown option '--debug'");
    expect(result).not.toBeNull();
    expect(result).toContain('--debug');
  });

  it('rephrases --verbose placed after subcommand', () => {
    const result = rephraseUnknownOption("error: unknown option '--verbose'");
    expect(result).not.toBeNull();
    expect(result).toContain('--verbose');
  });

  it('returns null for a non-global unknown flag (--foo)', () => {
    const result = rephraseUnknownOption("error: unknown option '--foo'");
    expect(result).toBeNull();
  });

  it('returns null for a completely unrelated string', () => {
    const result = rephraseUnknownOption('something else entirely');
    expect(result).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(rephraseUnknownOption('')).toBeNull();
  });

  it('example text includes the flag name in the usage hint', () => {
    const result = rephraseUnknownOption("error: unknown option '--dry-run'");
    expect(result).not.toBeNull();
    expect(result).toContain('testsprite --dry-run');
  });

  it('boolean flag (--dry-run) example does NOT include a <value> placeholder', () => {
    const result = rephraseUnknownOption("error: unknown option '--dry-run'");
    expect(result).not.toBeNull();
    expect(result).not.toContain('<value>');
    expect(result).toContain('testsprite --dry-run <subcommand>');
  });

  it('value flag (--output) example DOES include a <value> placeholder', () => {
    const result = rephraseUnknownOption("error: unknown option '--output'");
    expect(result).not.toBeNull();
    expect(result).toContain('testsprite --output <value> <subcommand>');
  });

  it('value flag (--endpoint-url) example DOES include a <value> placeholder', () => {
    const result = rephraseUnknownOption("error: unknown option '--endpoint-url'");
    expect(result).not.toBeNull();
    expect(result).toContain('testsprite --endpoint-url <value> <subcommand>');
  });
});
