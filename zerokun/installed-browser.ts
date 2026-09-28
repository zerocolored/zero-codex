import { lstatSync, readFileSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path'
import { homedir } from 'os'
import { readOptionalBoundedOwnerOnlyRegularFile } from './safe-file.ts'

/** The standard side-by-side installation, independent of a task's cwd/HOME. */
export function installedGoChromeEntrypoint(runtimeDirectory: string, projectRoot: string, home = homedir()): string | undefined {
  const candidates = [resolve(runtimeDirectory, '../../go-chrome-mcp')]
  try {
    const raw = readOptionalBoundedOwnerOnlyRegularFile(resolve(runtimeDirectory, '../.zerochan-release.json'), 8192)
    if (raw !== null) {
      const manifest = JSON.parse(raw)
      if (manifest.version !== 1 || !/^[a-f0-9]{40}$/.test(manifest.sha)) return
      if (basename(dirname(runtimeDirectory)) !== manifest.sha) return
      if (Object.hasOwn(manifest, 'chromeEntrypoint')) {
        if (typeof manifest.chromeEntrypoint !== 'string' || !isAbsolute(manifest.chromeEntrypoint)
          || !manifest.chromeEntrypoint.endsWith('/mcp-broker.js')) return
        // An explicit installation pin must never silently switch transports.
        return verifiedChromeEntrypoint(dirname(manifest.chromeEntrypoint), projectRoot)
      }
      // Migration for releases published before the installation was pinned.
      candidates.push(resolve(home, 'dev/go-chrome-mcp'))
    }
  } catch { return undefined }
  for (const root of candidates) {
    const entrypoint = verifiedChromeEntrypoint(root, projectRoot)
    if (entrypoint) return entrypoint
  }
  return undefined
}

function verifiedChromeEntrypoint(root: string, projectRoot: string): string | undefined {
  try {
    const entrypoint = resolve(root, 'mcp-broker.js')
    const project = realpathSync(projectRoot)
    const child = relative(project, root)
    if (child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))) return
    for (const path of [root, entrypoint, resolve(root, 'package.json'), resolve(root, 'manifest.json')]) {
      const info = lstatSync(path)
      if (info.isSymbolicLink() || realpathSync(path) !== path
        || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0
        || (path === root ? !info.isDirectory() : !info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024)) return
    }
    const parent = lstatSync(dirname(root))
    if (!parent.isDirectory() || (parent.mode & 0o022) !== 0) return
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
    if (pkg.name !== 'go-chrome-mcp' || manifest.name !== 'Go Chrome MCP' || manifest.manifest_version !== 3) return
    return entrypoint
  } catch { return undefined }
}
