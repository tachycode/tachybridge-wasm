import type Ros from "./Ros.js";
import type { ServiceOptions } from "./types.js";

export default class Service<TRequest = unknown, TResponse = unknown> {
  private readonly ros: Ros;
  private readonly name: string;
  private readonly serviceType: string;

  constructor(options: ServiceOptions) {
    this.ros = options.ros as Ros;
    this.name = options.name;
    this.serviceType = options.serviceType;
  }

  callService(
    request: TRequest,
    callback?: (response: TResponse) => void,
    failedCallback: (error: string) => void = console.error,
    timeoutSeconds?: number
  ): void {
    void this.ros._compatClient
      .callService(this.name, this.serviceType, request as Record<string, unknown>, {
        timeoutMs: timeoutSeconds && timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined
      })
      .then((response) => {
        callback?.(response as unknown as TResponse);
      })
      .catch((error: unknown) => {
        failedCallback(String(error));
      });
  }
}
