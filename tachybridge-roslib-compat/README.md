# tachybridge-roslib-compat

`tachybridge-roslib-compat` provides a roslib-style API on top of `tachybridge-wasm`.

## Purpose

- Reduce migration cost from existing roslib-style code
- Use `tachybridge-wasm` internally for `topic`, `service`, and native action flows

## Install

```bash
npm install tachybridge-roslib-compat
```

## Example

```ts
import { Ros, Topic, Service, Action } from "tachybridge-roslib-compat";

const ros = new Ros({ url: "ws://127.0.0.1:9090" });

const topic = new Topic({ ros, name: "/demo/out", messageType: "std_msgs/String" });
topic.subscribe((msg) => console.log(msg));
topic.publish({ text: "hello" });

const service = new Service({ ros, name: "/demo/sum", serviceType: "example/AddTwoInts" });
service.callService({ a: 1, b: 2 }, (res) => console.log(res));

const action = new Action({ ros, name: "/arm/move", actionType: "demo/MoveArm" });
const id = action.sendGoal({ x: 1 }, (result) => console.log(result));
action.cancelGoal(id);

const cli = await ros.executeCli("ros2 node list");
console.log(cli.output);
```

For CBOR binary frames:

```ts
const ros = new Ros({ url: "ws://127.0.0.1:9090", codec: "cbor" });
```

## Limits

- Not a full 1:1 implementation of all roslib APIs
- `ActionClient/Goal` object model is not included
- `topic.compression` is forwarded to subscribe op (`none/png/cbor/cbor-raw`)

## Test

```bash
npm run test -w tachybridge-roslib-compat
```
