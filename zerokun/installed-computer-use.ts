import { lstatSync, realpathSync } from 'fs'
import { join, relative, isAbsolute, sep } from 'path'

/** Resolve the operator-installed native CUA client, never a project transport. */
export function installedComputerUseClient(codexHome: string, projectRoot: string): string | undefined {
  try {
    const home = realpathSync(codexHome)
    const root = join(home, 'computer-use')
    const client = join(root, 'Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient')
    const project = realpathSync(projectRoot)
    const contains = (parent: string, candidate: string) => {
      const child = relative(parent, candidate)
      return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
    }
    if (contains(project, root) || contains(root, project)) return
    let current = home
    for (const part of relative(home, client).split(sep)) {
      current = join(current, part)
      const info = lstatSync(current)
      if (info.isSymbolicLink() || realpathSync(current) !== current
        || (info.uid !== 0 && info.uid !== process.getuid?.()) || (info.mode & 0o022) !== 0
        || (current === client ? !info.isFile() || info.nlink !== 1 || (info.mode & 0o111) === 0 : !info.isDirectory())) return
    }
    return client
  } catch { return undefined }
}
