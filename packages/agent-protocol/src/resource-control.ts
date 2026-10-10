export type ResourceControlResult = {
  data?: unknown;
  error?: { code: string; message: string; uncertain?: boolean };
  truncated?: boolean;
};
