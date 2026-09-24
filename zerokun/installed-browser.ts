import { lstatSync, readFileSync, realpathSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'

/** The standard side-by-side installation, independent of a task's cwd/HOME. */
export function installedGoChromeEntrypoint(runtimeDirectory: string, projectRoot: string): string | undefined {
  try {
    const root = resolve(runtimeDirectory, '../../go-chrome-mcp')
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
