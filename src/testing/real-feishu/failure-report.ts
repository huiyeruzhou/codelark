export interface SerializedFailureError {
  message: string;
  name?: string;
  stack?: string;
  cause?: SerializedFailureError;
}

export function serializeFailureError(error: unknown): SerializedFailureError {
  if (error instanceof Error) {
    const cause = 'cause' in error && error.cause !== undefined
      ? serializeFailureError(error.cause)
      : undefined;
    return {
      message: error.message,
      ...(error.name ? { name: error.name } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
      ...(cause ? { cause } : {}),
    };
  }
  return { message: String(error) };
}
