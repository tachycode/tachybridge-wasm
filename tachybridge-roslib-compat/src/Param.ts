import Service from "./Service.js";
import type Ros from "./Ros.js";

export default class Param<T = unknown> {
  private readonly ros: Ros;
  private readonly name: string;

  constructor({ ros, name }: { ros: Ros; name: string }) {
    this.ros = ros;
    this.name = name;
  }

  get(callback: (value: T) => void, failedCallback: (error: string) => void = console.error): void {
    const svc = new Service<{ name: string }, { value: string; successful?: boolean; reason?: string }>({
      ros: this.ros,
      name: "rosapi/get_param",
      serviceType: "rosapi/GetParam"
    });

    svc.callService(
      { name: this.name },
      (response) => {
        if (response.successful === false) {
          failedCallback(String(response.reason ?? "get_param failed"));
          return;
        }
        callback(JSON.parse(response.value) as T);
      },
      failedCallback
    );
  }

  set(value: T, callback?: (message: unknown) => void, failedCallback: (error: string) => void = console.error): void {
    const svc = new Service<{ name: string; value: string }, unknown>({
      ros: this.ros,
      name: "rosapi/set_param",
      serviceType: "rosapi/SetParam"
    });

    svc.callService(
      { name: this.name, value: JSON.stringify(value) },
      (response) => {
        callback?.(response);
      },
      failedCallback
    );
  }

  delete(callback: (message: unknown) => void, failedCallback: (error: string) => void = console.error): void {
    const svc = new Service<{ name: string }, unknown>({
      ros: this.ros,
      name: "rosapi/delete_param",
      serviceType: "rosapi/DeleteParam"
    });

    svc.callService({ name: this.name }, callback, failedCallback);
  }
}
