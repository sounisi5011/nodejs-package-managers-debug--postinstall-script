import type { JsonObject } from 'type-fest';

export interface OutputData extends JsonObject {
  readonly postinstallType: string | null;
  readonly binName: string | null;
  readonly actual: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | null>>;
    readonly pnpVersion: string | null;
    readonly isGlobalMode: boolean;
    readonly binCommandResult:
      | ({
          readonly stdout: string;
          readonly stderr: string;
          readonly error: string | null;
        } & Readonly<
          Record<
            `${'readable' | 'executed'}Command`,
            {
              readonly command: string;
              readonly args: readonly string[];
            }
          >
        >)
      | null;
    readonly foundBinFiles: readonly string[] | null;
  };
}
