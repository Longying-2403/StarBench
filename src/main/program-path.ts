// Where the programs the app starts by name are found. On Windows a program named without a
// folder is looked for in the working folder before PATH: by Node itself when it starts a process
// (unless the variable NoDefaultCurrentDirectoryInExePath is set, which Windows does not do), and
// always by the helper that MCP servers are started with. The working folder is often one the
// person did not write: a repository they cloned, a folder they unpacked. A `powershell.exe` lying
// in it would run in place of the real one at the first command they allow, whatever that command
// says. So the programs of Windows are named by their full path, and other programs are looked up
// in PATH first.
// Nothing in this file depends on Electron.

import { statSync } from 'node:fs'
import path from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

/** The value of a variable, whatever the case of its name: on Windows, PATH may be written Path. */
export function envValue(env: Env, name: string): string | undefined {
  const wanted = name.toUpperCase()
  for (const key of Object.keys(env)) if (key.toUpperCase() === wanted) return env[key]
  return undefined
}

/** The folder Windows is installed in. */
function windowsFolder(env: Env): string {
  return envValue(env, 'SystemRoot') || envValue(env, 'windir') || 'C:\\Windows'
}

/** A program that comes with Windows, by its full path: `system32('taskkill.exe')`. */
export function system32(program: string, env: Env = process.env): string {
  return path.win32.join(windowsFolder(env), 'System32', program)
}

/** Windows PowerShell, the shell of run_command on Windows, by its full path. */
export function windowsPowerShell(env: Env = process.env): string {
  return path.win32.join(windowsFolder(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * The full path of the program a command names, as found in `searchPath` (the PATH it is started
 * with), trying the endings `pathExt` lists. A command that names a folder, and one that PATH does
 * not have, is handed back as it is and started as before. Only on Windows: elsewhere a program
 * named without a folder is not looked for in the working folder anyway.
 */
export function onPath(command: string, searchPath: string | undefined, pathExt: string | undefined, platform: string = process.platform): string {
  if (platform !== 'win32' || !command || /[\\/:]/.test(command)) return command
  // A folder in PATH that is not written out in full would be read against the working folder too.
  const folders = (searchPath ?? '')
    .split(';')
    .map((folder) => folder.trim().replace(/^"(.*)"$/, '$1'))
    .filter((folder) => path.win32.isAbsolute(folder))
  const endings = (pathExt || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ending) => ending.trim())
    .filter(Boolean)
  const names = path.win32.extname(command) ? [command, ...endings.map((ending) => command + ending)] : endings.map((ending) => command + ending)
  for (const folder of folders) {
    for (const name of names) {
      const full = path.win32.join(folder, name)
      try {
        if (statSync(full).isFile()) return full
      } catch {
        // Not in this folder.
      }
    }
  }
  return command
}
