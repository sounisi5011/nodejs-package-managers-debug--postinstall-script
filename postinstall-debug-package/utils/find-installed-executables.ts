import { readdir } from 'fs/promises';
import * as path from 'path';

export async function findInstalledExecutables(
  cwdList: readonly string[],
  dirnameList: readonly string[],
  binName: string,
): Promise<string[]> {
  const bindirSet = new Set<string>(
    cwdList
      .flatMap((cwd) => {
        const cwdList: string[] = [];
        while (true) {
          cwdList.push(cwd);
          const parentDir = path.dirname(cwd);
          if (parentDir === cwd) break;
          cwd = parentDir;
        }
        return cwdList;
      })
      .sort()
      .flatMap((cwd) =>
        dirnameList.map((dirname) => (dirname ? path.join(cwd, dirname) : cwd)),
      ),
  );

  const binFilepathList: string[] = [];
  for (const bindir of bindirSet) {
    const filenameList = await readdir(bindir).catch(() => []);
    binFilepathList.push(
      ...filenameList
        .filter(
          (filename) =>
            filename === binName || filename.startsWith(`${binName}.`),
        )
        .map((filename) => path.join(bindir, filename)),
    );
  }

  return binFilepathList;
}
