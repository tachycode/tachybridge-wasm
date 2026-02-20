export class ServiceRequest<T extends Record<string, unknown> = Record<string, unknown>> {
  constructor(values: T) {
    Object.assign(this, values);
  }
}

export class ServiceResponse<T extends Record<string, unknown> = Record<string, unknown>> {
  constructor(values: T) {
    Object.assign(this, values);
  }
}
