import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { promptSecret, promptText } from './prompt.js';

class CaptureStream extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error) => void): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    cb();
  }
  text(): string {
    return this.chunks.join('');
  }
}

describe('promptText', () => {
  it('returns the typed line, stripping the trailing newline', async () => {
    const input = Readable.from(['hello world\n']);
    const output = new CaptureStream();
    const result = await promptText('Name: ', { input, output });
    expect(result).toBe('hello world');
    expect(output.text()).toContain('Name: ');
  });

  it('handles input arriving in multiple chunks', async () => {
    async function* gen() {
      yield 'foo';
      yield 'bar';
      yield '\n';
    }
    const input = Readable.from(gen());
    const output = new CaptureStream();
    expect(await promptText('? ', { input, output })).toBe('foobar');
  });

  it('handles CRLF terminators', async () => {
    const input = Readable.from(['ok\r\n']);
    const output = new CaptureStream();
    expect(await promptText('? ', { input, output })).toBe('ok');
  });

  it('returns the buffered input on stream end without newline', async () => {
    const input = Readable.from(['eof-no-newline']);
    const output = new CaptureStream();
    expect(await promptText('? ', { input, output })).toBe('eof-no-newline');
  });
});

describe('promptSecret (non-TTY behavior)', () => {
  it('returns the typed secret', async () => {
    const input = Readable.from(['sk-hidden-12345\n']);
    const output = new CaptureStream();
    const result = await promptSecret('Key: ', { input, output });
    expect(result).toBe('sk-hidden-12345');
  });

  it('does not echo the secret to the output stream', async () => {
    const input = Readable.from(['sk-hidden-12345\n']);
    const output = new CaptureStream();
    await promptSecret('Key: ', { input, output });
    const written = output.text();
    expect(written).toContain('Key: ');
    expect(written).not.toContain('sk-hidden-12345');
  });

  it('honors DEL/backspace before submission', async () => {
    const DEL = String.fromCharCode(0x7f);
    const input = Readable.from([`abc${DEL}d\n`]);
    const output = new CaptureStream();
    expect(await promptSecret('? ', { input, output })).toBe('abd');
  });

  it('rejects on Ctrl-C input', async () => {
    const ETX = String.fromCharCode(0x03);
    const input = Readable.from([`abc${ETX}`]);
    const output = new CaptureStream();
    await expect(promptSecret('? ', { input, output })).rejects.toThrow(/cancelled/i);
  });
});
