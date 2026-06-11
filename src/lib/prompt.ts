import type { Readable, Writable } from 'node:stream';

export interface PromptStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

interface RawModeCapable {
  setRawMode?: (mode: boolean) => unknown;
  isTTY?: boolean;
  resume?: () => unknown;
}

export async function promptText(question: string, streams: PromptStreams = {}): Promise<string> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  output.write(question);
  return readLine(input, output, false);
}

export async function promptSecret(question: string, streams: PromptStreams = {}): Promise<string> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  output.write(question);

  const inputAsTTY = input as Readable & RawModeCapable;
  const useRawMode = inputAsTTY.isTTY === true && typeof inputAsTTY.setRawMode === 'function';
  if (useRawMode) inputAsTTY.setRawMode!(true);
  try {
    return await readLine(input, output, useRawMode);
  } finally {
    if (useRawMode) inputAsTTY.setRawMode!(false);
  }
}

function readLine(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  mask: boolean,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let resolved = false;

    const onData = (chunk: Buffer | string): void => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      for (const ch of str) {
        const code = ch.charCodeAt(0);
        // Enter (CR or LF)
        if (code === 13 || code === 10) {
          finish();
          return;
        }
        // Ctrl-C
        if (code === 3) {
          cleanup();
          output.write('\n');
          if (!resolved) {
            resolved = true;
            reject(new Error('Prompt cancelled.'));
          }
          return;
        }
        // Backspace / DEL
        if (code === 127 || code === 8) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            if (mask) output.write('\b \b');
          }
          continue;
        }
        // Drop other control chars
        if (code < 32) continue;
        buffer += ch;
        if (mask) output.write('*');
      }
    };

    const onEnd = (): void => {
      finish();
    };

    const onError = (err: Error): void => {
      cleanup();
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    };

    const cleanup = (): void => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      const pausable = input as { pause?: () => unknown };
      if (typeof pausable.pause === 'function') pausable.pause();
    };

    const finish = (): void => {
      cleanup();
      output.write('\n');
      if (!resolved) {
        resolved = true;
        resolve(buffer);
      }
    };

    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
    const resumable = input as { resume?: () => unknown };
    if (typeof resumable.resume === 'function') resumable.resume();
  });
}

export type { Writable };
