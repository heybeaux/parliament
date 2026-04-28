export interface ModelAdapter {
  generate(prompt: string, system?: string): Promise<string>;
}

export class ModelConnectionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ModelConnectionError';
  }
}
