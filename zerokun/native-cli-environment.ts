import { join } from 'path'

// Configuration search paths, not credentials or a list of supported CLIs.
export const NATIVE_CONFIG_ENV_KEYS = [
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS',
] as const

export function nativeCliShellEnvironment(
  home: string,
  scratch: string,
  primary: boolean,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (primary) {
    return { HOME: home, ...Object.fromEntries(NATIVE_CONFIG_ENV_KEYS.flatMap(key =>
      source[key] ? [[key, source[key]!]] : [])) }
  }
  return {
    HOME: scratch,
    XDG_CONFIG_HOME: join(scratch, '.config'),
    XDG_CACHE_HOME: join(scratch, '.cache'),
    XDG_DATA_HOME: join(scratch, '.local/share'),
    XDG_STATE_HOME: join(scratch, '.local/state'),
    XDG_CONFIG_DIRS: join(scratch, '.config'),
    XDG_DATA_DIRS: join(scratch, '.local/share'),
  }
}
