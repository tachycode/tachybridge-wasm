import type Ros from "./Ros.js";
import type { CliOptions, JsonMap } from "./types.js";

export default class Cli<TResponse = JsonMap> {
  private readonly ros: Ros;
  private readonly defaultCommand?: string;

  constructor(options: CliOptions) {
    this.ros = options.ros as Ros;
    this.defaultCommand = options.command;
  }

  execute(command: string, timeoutSeconds?: number): Promise<TResponse> {
    return this.ros.executeCli(command, {
      timeoutMs: timeoutSeconds && timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined
    }) as Promise<TResponse>;
  }

  run(
    callback?: (response: TResponse) => void,
    failedCallback: (error: string) => void = console.error,
    timeoutSeconds?: number
  ): void {
    if (!this.defaultCommand) {
      failedCallback("Cli.run requires options.command");
      return;
    }
    void this.execute(this.defaultCommand, timeoutSeconds)
      .then((response) => {
        callback?.(response);
      })
      .catch((error: unknown) => {
        failedCallback(String(error));
      });
  }
}
