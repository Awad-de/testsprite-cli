import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROFILE, defaultCredentialsPath, readProfile } from './credentials.js';

export interface Config {
  apiUrl: string;
  apiKey?: string;
  profile: string;
}

export interface LoadConfigOptions {
  profile?: string;
  endpointUrl?: string;
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
}

const DEFAULT_API_URL = 'https://api.testsprite.com';

export function defaultConfigPath(): string {
  return join(homedir(), '.testsprite', 'config');
}

/**
 * Resolves the active profile name and its (apiUrl, apiKey) pair.
 *
 * Resolution order, highest precedence first:
 *   profile name:  options.profile  > env.TESTSPRITE_PROFILE > "default"
 *   apiKey:        env.TESTSPRITE_API_KEY > credentials file profile entry
 *   apiUrl:        options.endpointUrl > env.TESTSPRITE_API_URL > credentials file > built-in default
 *
 * Env wins over the credentials file so CI / scripted callers can run without touching
 * the user's ~/.testsprite/credentials.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const env = options.env ?? process.env;
  const profile = options.profile ?? env.TESTSPRITE_PROFILE ?? DEFAULT_PROFILE;
  const credentialsPath = options.credentialsPath ?? defaultCredentialsPath();
  const fileEntry = readProfile(profile, { path: credentialsPath });

  return {
    apiUrl: options.endpointUrl ?? env.TESTSPRITE_API_URL ?? fileEntry?.apiUrl ?? DEFAULT_API_URL,
    apiKey: env.TESTSPRITE_API_KEY ?? fileEntry?.apiKey,
    profile,
  };
}
