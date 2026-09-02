/** Base class for all typed errors raised by the server. */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Configuration could not be loaded or validated. */
export class ConfigError extends AppError {}

/** A provider was asked to act but its credentials/environment are missing. */
export class ProviderUnavailableError extends AppError {}

/** A PowerShell invocation failed (non-zero exit, spawn error, or bad output). */
export class PowerShellError extends AppError {
  constructor(
    message: string,
    public readonly stderr?: string,
    public readonly exitCode?: number | null
  ) {
    super(message);
  }
}

/** A PowerShell invocation exceeded its timeout and was force-killed. */
export class PowerShellTimeoutError extends PowerShellError {}

/** A tool call was refused by the risk gate. */
export class RiskBlockedError extends AppError {
  constructor(
    message: string,
    public readonly score: number,
    public readonly reasons: string[]
  ) {
    super(message);
  }
}
