import { basename, resolve } from 'path'

/** Folder names are the user-defined project identity; Git and manual membership are not required. */
export function fleetProject(project: string): { key: string; label: string } | null {
  const name=basename(resolve(project)).normalize('NFC')
  if (!name || name.length>100 || /[\\/\x00-\x1f\x7f]/.test(name)) return null
  return {key:name,label:name}
}
