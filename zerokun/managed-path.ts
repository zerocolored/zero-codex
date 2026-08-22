#!/usr/bin/env bun

import { chmodSync, lstatSync, mkdirSync, realpathSync } from 'fs'
import { relative, resolve, sep } from 'path'

type FileMetadata = NonNullable<ReturnType<typeof lstatSync>>

function requireOwnedDirectory(path: string): void {
  const metadata = lstatSync(path) as FileMetadata
  const ownerMatches = typeof process.getuid !== 'function' || metadata.uid === process.getuid()
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !ownerMatches) {
    throw new Error(`unsafe managed directory: ${path}`)
  }
}

function requirePrivateDirectory(path: string): void {
  requireOwnedDirectory(path)
  const metadata = lstatSync(path) as FileMetadata
  if ((Number(metadata.mode) & 0o077) !== 0) {
    throw new Error(`managed directory is not private: ${path}`)
  }
}

function contained(root: string, candidate: string): { base: string; path: string } {
  const lexicalBase = resolve(root)
  const base = realpathSync(lexicalBase)
  const lexicalPath = resolve(candidate)
  let path: string
  if (lexicalPath === lexicalBase || lexicalPath.startsWith(lexicalBase + sep)) {
    path = resolve(base, relative(lexicalBase, lexicalPath))
  } else if (lexicalPath === base || lexicalPath.startsWith(base + sep)) {
    path = lexicalPath
  } else {
    throw new Error(`managed path is outside state: ${candidate}`)
  }
  return { base, path }
}

function walkManagedDirectory(root: string, candidate: string, create: boolean): string {
  const { base, path } = contained(root, candidate)
  requirePrivateDirectory(base)
  let current = base
  for (const component of relative(base, path).split(sep).filter(Boolean)) {
    current = resolve(current, component)
    if (create) {
      try { mkdirSync(current, { mode: 0o700 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    requireOwnedDirectory(current)
  }
  return path
}

export function requireManagedStateRoot(root: string): string {
  const lexical = resolve(root)
  // Validate the requested directory entry before realpath; otherwise a
  // symlink in the final component is silently accepted as its target.
  requirePrivateDirectory(lexical)
  const path = realpathSync(lexical)
  requirePrivateDirectory(path)
  return path
}

export function prepareManagedStateRoot(root: string): string {
  const lexical = resolve(root)
  try { mkdirSync(lexical, { recursive: true, mode: 0o700 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  requireOwnedDirectory(lexical)
  chmodSync(lexical, 0o700)
  return requireManagedStateRoot(lexical)
}

export function requireManagedDirectory(root: string, candidate: string): string {
  return walkManagedDirectory(root, candidate, false)
}

export function ensureManagedDirectory(root: string, candidate: string): string {
  return walkManagedDirectory(root, candidate, true)
}

if (import.meta.main) {
  const [command, root, ...candidates] = process.argv.slice(2)
  if (!root || (command !== 'prepare-root' && command !== 'prepare-directories')) {
    process.stderr.write('usage: managed-path.ts prepare-root <state-directory> | prepare-directories <state-directory> <directory>...\n')
    process.exit(2)
  }
  try {
    if (command === 'prepare-root') {
      process.stdout.write(`${prepareManagedStateRoot(root)}\n`)
    } else {
      requireManagedStateRoot(root)
      if (candidates.length === 0) throw new Error('at least one managed directory is required')
      for (const candidate of candidates) ensureManagedDirectory(root, candidate)
    }
  } catch (error) {
    process.stderr.write(`unsafe state directory: ${error}\n`)
    process.exit(1)
  }
}
