import type Ros from "./Ros.js";
import type { ActionOptions, JsonMap } from "./types.js";

export default class Action<TGoal = unknown, TFeedback = unknown, TResult = unknown> {
  private readonly ros: Ros;
  private readonly name: string;
  private readonly actionType: string;
  private readonly activeSessions = new Set<string>();

  constructor(options: ActionOptions) {
    this.ros = options.ros as Ros;
    this.name = options.name;
    this.actionType = options.actionType;
  }

  sendGoal(
    goal: TGoal,
    resultCallback: (result: TResult) => void,
    feedbackCallback?: (feedback: TFeedback) => void,
    failedCallback: (error: string) => void = console.error
  ): string {
    const id = `send_action_goal:${this.name}:${Date.now()}:${Math.floor(Math.random() * 10000)}`;
    this.activeSessions.add(id);

    void this.ros._compatClient
      .sendActionGoal({
        action: this.name,
        actionType: this.actionType,
        goal: goal as JsonMap,
        id,
        sessionId: id,
        // roslib-style default: no client-side action timeout unless explicitly requested by app layer.
        timeoutMs: 0,
        onFeedback: (feedback) => {
          feedbackCallback?.(feedback as unknown as TFeedback);
        }
      })
      .then((handle) => handle.completion)
      .then((result) => {
        this.activeSessions.delete(id);
        resultCallback(result as unknown as TResult);
      })
      .catch((error: unknown) => {
        this.activeSessions.delete(id);
        failedCallback(String(error));
      });

    return id;
  }

  cancelGoal(id: string): void {
    void this.ros._compatClient.cancelActionGoal({
      action: this.name,
      actionType: this.actionType,
      sessionId: id
    });
  }

  cancelAllGoals(): void {
    for (const sessionId of Array.from(this.activeSessions)) {
      this.cancelGoal(sessionId);
    }
  }
}
