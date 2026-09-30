import { lstatSync, realpathSync } from 'fs'
import { dirname, join, relative, isAbsolute, sep } from 'path'

/** Only the installed official Node runtime may inherit the desktop connection. */
export function installedComputerUseNodeRepl(
  projectRoot: string,
  command: unknown,
  applicationRoot = '/Applications/ChatGPT.app',
): boolean {
  try {
    const client = join(applicationRoot, 'Contents/Resources/cua_node/bin/node_repl')
    if (command !== client) return false
    const project = realpathSync(projectRoot)
    const contains = (parent: string, child: string) => {
      const path = relative(parent, child)
      return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
    }
    if (contains(project, applicationRoot) || contains(applicationRoot, project)) return false
    let current = applicationRoot
    for (const part of ['', ...relative(applicationRoot, client).split(sep)]) {
      if (part) current = join(current, part)
      const info = lstatSync(current)
      if (info.isSymbolicLink() || realpathSync(current) !== current
        || (info.uid !== 0 && info.uid !== process.getuid?.()) || (info.mode & 0o022) !== 0
        || (current === client ? !info.isFile() || info.nlink !== 1 || (info.mode & 0o111) === 0 : !info.isDirectory())) return false
    }
    return true
  } catch { return false }
}

/** The trusted worker calls process.cwd() before executing any user code. */
export function installedComputerUseNodeServer(
  projectRoot: string,
  server: Record<string, unknown>,
  applicationRoot = '/Applications/ChatGPT.app',
): Record<string, unknown> | undefined {
  if (!installedComputerUseNodeRepl(projectRoot, server.command, applicationRoot)) return
  // A managed multi-repository workspace denies its container directory while
  // allowing selected children. Inheriting that container as cwd crashes Node
  // with EPERM/uv_cwd. The verified app directory is already readable by CUA;
  // use it without opening the container or changing an operator-specified cwd.
  return { ...server, cwd: server.cwd ?? dirname(server.command as string) }
}

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
