import { spawn } from 'node:child_process'
import path from 'node:path'
import { execa } from 'execa'

export interface WorkerProcessHandle {
  process: ReturnType<typeof spawn>
}

export class PythonWorkerService {
  private readonly projectDirectory = path.join(process.cwd(), 'py')

  async runJsonCommand<T>(command: string, payload: unknown): Promise<T> {
    const subprocess = await execa(
      'uv',
      [
        'run',
        '--project',
        this.projectDirectory,
        'python',
        '-m',
        'liked_music_syncer.cli',
        command,
      ],
      {
        input: JSON.stringify(payload),
        reject: false,
      }
    )

    if (subprocess.exitCode !== 0) {
      throw new Error(
        subprocess.stderr.trim() ||
          subprocess.stdout.trim() ||
          `Worker command failed: ${command}`
      )
    }

    const lines = subprocess.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const lastLine = lines.at(-1)

    if (!lastLine) {
      throw new Error(`Worker command returned no output: ${command}`)
    }

    return JSON.parse(lastLine) as T
  }

  spawnNdjsonCommand(command: string, payload: unknown) {
    const child = spawn(
      'uv',
      [
        'run',
        '--project',
        this.projectDirectory,
        'python',
        '-m',
        'liked_music_syncer.cli',
        command,
      ],
      {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )
    child.stdin.end(JSON.stringify(payload))
    return child
  }
}
