import * as child_process from 'child_process';
import * as path from 'path';
import { promisify } from 'util';

import usedPM from 'used-pm';

const execAsync = promisify(child_process.exec);

/**
 * @see https://github.com/go-task/go-npm/blob/v0.1.17/src/common.js#L23-L60
 */
export async function getInstallationPath(): Promise<string> {
  const { stdout, stderr } = await execAsync('npm bin').catch(() => ({
    stdout: '',
    stderr: '',
  }));

  let dir = null;
  if (stderr || !stdout || stdout.length === 0) {
    const env = process.env;

    const packageManager = usedPM();

    if (env && env['npm_config_prefix']) {
      dir = path.join(env['npm_config_prefix'], 'bin');
    } else if (env && env['npm_config_local_prefix']) {
      dir = path.join(
        env['npm_config_local_prefix'],
        path.join('node_modules', '.bin'),
      );
    } else if (packageManager?.name.toLowerCase() === 'pnpm') {
      dir = path.join(process.cwd(), 'node_modules', '.bin');
    } else {
      throw new Error('Error finding binary installation directory');
    }
  } else {
    dir = stdout.trim();
  }

  dir = dir.replace(
    /node_modules.*[\/\\]\.bin/,
    path.join('node_modules', '.bin'),
  );
  return dir;
}
